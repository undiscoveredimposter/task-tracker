import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ListDetail, ListSummary, ServerEvent, Task } from '@tally/shared';
import { ApiError, api, OfflineError } from './api';
import { useAuth } from './auth';
import { readCache, restoreSnapshot } from './cache';
import { auth } from './firebase';
import { Outbox, type PendingTick } from './outbox';
import { connectStream } from './stream';

interface DataState {
  lists: ListSummary[];
  listsLoading: boolean;
  error: string | null;
  connected: boolean;
  online: boolean;
  pending: number;
  /** When what's on screen last matched the server. Null until it ever has. */
  savedAt: number | null;
  refreshLists: () => Promise<void>;
  getList: (id: string) => ListDetail | undefined;
  loadList: (id: string) => Promise<ListDetail | undefined>;
  setList: (detail: ListDetail) => void;
  dropList: (id: string) => void;
  toggleTask: (listId: string, task: Task) => void;
}

const DataContext = createContext<DataState | null>(null);

const storage: Storage | undefined = typeof window === 'undefined' ? undefined : window.localStorage;

export function DataProvider({ children }: { children: ReactNode }) {
  const { me, firebaseUser } = useAuth();
  const uid = firebaseUser?.uid ?? null;
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [details, setDetails] = useState<Record<string, ListDetail>>({});
  const [listsLoading, setListsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [pending, setPending] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const outbox = useRef<Outbox>(
    new Outbox(
      storage ?? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    ),
  );
  const hydratedFor = useRef<string | null>(null);
  const lastUid = useRef<string | null>(null);

  const refreshLists = useCallback(async () => {
    try {
      setLists(await api.lists());
      setSavedAt(Date.now());
      setError(null);
    } catch (cause) {
      if (!(cause instanceof OfflineError)) setError((cause as Error).message);
    } finally {
      setListsLoading(false);
    }
  }, []);

  const loadList = useCallback(async (id: string) => {
    try {
      const detail = await api.list(id);
      setDetails((current) => ({ ...current, [id]: detail }));
      setSavedAt(Date.now());
      setError(null);
      return detail;
    } catch (cause) {
      if (!(cause instanceof OfflineError)) setError((cause as Error).message);
      return undefined;
    }
  }, []);

  const setList = useCallback((detail: ListDetail) => {
    setDetails((current) => ({ ...current, [detail.id]: detail }));
    setLists((current) =>
      current.map((list) => (list.id === detail.id ? { ...list, ...summaryOf(detail) } : list)),
    );
  }, []);

  const dropList = useCallback((id: string) => {
    setDetails((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setLists((current) => current.filter((list) => list.id !== id));
  }, []);

  /** Sends whatever is queued, then reconciles with the server's version. */
  const flushOutbox = useCallback(async () => {
    if (outbox.current.size === 0) return;

    const touched = new Set(outbox.current.pending.map((tick) => tick.listId));
    const result = await outbox.current.flush(async (tick: PendingTick) => {
      if (tick.action === 'complete') await api.complete(tick.taskId);
      else await api.uncomplete(tick.taskId);
    });
    setPending(outbox.current.size);

    // Refetch what changed so the attribution ("Sam · 7:42am") matches whatever
    // the server actually recorded, including someone else having got there first.
    if (result.sent > 0 || result.dropped) {
      await Promise.all([...touched].map((listId) => loadList(listId)));
      await refreshLists();
    }
  }, [loadList, refreshLists]);

  /**
   * Ticks a task. The UI updates immediately and the request follows; if it
   * can't get through, the change waits in the outbox. Replay is safe because
   * completing is idempotent on the server.
   */
  const toggleTask = useCallback(
    (listId: string, task: Task) => {
      const nextCompleted = !task.completion;
      const optimistic = nextCompleted && me
        ? { at: new Date().toISOString(), by: { ...me } }
        : null;

      setDetails((current) => {
        const detail = current[listId];
        if (!detail) return current;
        return {
          ...current,
          [listId]: {
            ...detail,
            doneCount: detail.doneCount + (nextCompleted ? 1 : -1),
            tasks: detail.tasks.map((item) =>
              item.id === task.id ? { ...item, completion: optimistic } : item,
            ),
          },
        };
      });
      setLists((current) =>
        current.map((list) =>
          list.id === listId
            ? { ...list, doneCount: list.doneCount + (nextCompleted ? 1 : -1) }
            : list,
        ),
      );

      const send = nextCompleted ? api.complete(task.id) : api.uncomplete(task.id);
      void send
        .then(() => loadList(listId))
        .catch((cause: unknown) => {
          if (cause instanceof OfflineError) {
            outbox.current.enqueue({
              taskId: task.id,
              listId,
              action: nextCompleted ? 'complete' : 'uncomplete',
              at: Date.now(),
            });
            setPending(outbox.current.size);
            return;
          }
          // A real refusal — put the row back and say why.
          setError(cause instanceof ApiError ? cause.message : 'Could not save that');
          void loadList(listId);
        });
    },
    [loadList, me],
  );

  /* Signing out — or somebody else signing in on a shared tablet — must leave
     the last person's lists and unsent ticks on neither the screen nor the disk. */
  useEffect(() => {
    if (lastUid.current && lastUid.current !== uid) {
      readCache.clear();
      outbox.current.clear();
      hydratedFor.current = null;
      setLists([]);
      setDetails({});
      setSavedAt(null);
      setPending(0);
      setListsLoading(true);
    }
    lastUid.current = uid;
  }, [uid]);

  /* The saved copy goes up before the network is asked anything, so a list is
     on screen in a lift or a basement. Live data replaces it when the request
     lands; offline it simply stays. */
  useEffect(() => {
    if (!uid || hydratedFor.current === uid) return;
    hydratedFor.current = uid;

    const snapshot = readCache.read(uid);
    if (!snapshot) return;

    const restored = restoreSnapshot(snapshot, outbox.current.pending);
    setLists(restored.lists);
    setDetails(restored.details);
    setSavedAt(snapshot.savedAt);
    setListsLoading(false);
  }, [uid]);

  /* Keep that copy up to date, optimistic ticks included. `savedAt` travels
     with the data rather than being the moment of the write, so a copy that has
     sat offline all morning still says when it was last true. */
  useEffect(() => {
    if (!uid || !me || savedAt === null) return;
    readCache.write({ uid, me, savedAt, lists, details });
  }, [uid, me, savedAt, lists, details]);

  /* Initial load. */
  useEffect(() => {
    if (!me) return;
    setPending(outbox.current.size);
    void refreshLists().then(flushOutbox);
  }, [me, refreshLists, flushOutbox]);

  /* Live updates from everyone else's devices. */
  useEffect(() => {
    if (!me) return;

    const applyEvent = (event: ServerEvent) => {
      switch (event.type) {
        case 'task.completed':
        case 'task.uncompleted':
        case 'task.changed':
        case 'members.changed':
          void loadList(event.listId);
          void refreshLists();
          break;
        case 'list.changed':
          void loadList(event.listId);
          void refreshLists();
          break;
        case 'list.deleted':
          dropList(event.listId);
          break;
        case 'hello':
          break;
      }
    };

    return connectStream({
      getToken: async () => auth().currentUser?.getIdToken() ?? null,
      onEvent: applyEvent,
      onConnected: setConnected,
    });
  }, [me, loadList, refreshLists, dropList]);

  /* Network transitions: drain the outbox the moment we're back. */
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      void flushOutbox();
    };
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [flushOutbox]);

  /* Coming back to the app after it was backgrounded — the phone may have been
     asleep for hours and the stream long since dropped. */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !me) return;
      void refreshLists().then(flushOutbox);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [me, refreshLists, flushOutbox]);

  const value = useMemo<DataState>(
    () => ({
      lists,
      listsLoading,
      error,
      connected,
      online,
      pending,
      savedAt,
      refreshLists,
      getList: (id: string) => details[id],
      loadList,
      setList,
      dropList,
      toggleTask,
    }),
    [
      lists,
      listsLoading,
      error,
      connected,
      online,
      pending,
      savedAt,
      details,
      refreshLists,
      loadList,
      setList,
      dropList,
      toggleTask,
    ],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

function summaryOf(detail: ListDetail): Partial<ListSummary> {
  const { tasks, members, ...rest } = detail;
  void tasks;
  return { ...rest, members };
}

export function useData(): DataState {
  const context = useContext(DataContext);
  if (!context) throw new Error('useData must be used inside DataProvider');
  return context;
}
