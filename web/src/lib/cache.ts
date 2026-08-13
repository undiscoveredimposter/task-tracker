import type { ListDetail, ListSummary, Me, UserRef } from '@tally/shared';
import type { PendingTick } from './outbox';

/**
 * The last-known lists and tasks, kept on the device so the app opens to
 * something in a basement with no signal.
 *
 * It is a copy and never a source of truth: whatever the server says replaces
 * it outright. The service worker precaches the shell; this is the part that
 * makes the shell worth loading.
 */

/** Bumped when the stored shape changes, so an old copy is dropped rather than trusted. */
export const CACHE_VERSION = 1;

const STORAGE_KEY = 'tally.cache';

export interface CachedSnapshot {
  version: number;
  /** Firebase uid — known before the API answers, so a cold offline launch can check it. */
  uid: string;
  me: Me;
  /** When this last reflected the server, not when it was last written to disk. */
  savedAt: number;
  lists: ListSummary[];
  details: Record<string, ListDetail>;
}

export interface CacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isSnapshot(value: unknown): value is CachedSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<CachedSnapshot>;
  return (
    snapshot.version === CACHE_VERSION &&
    typeof snapshot.uid === 'string' &&
    typeof snapshot.savedAt === 'number' &&
    typeof snapshot.me === 'object' &&
    snapshot.me !== null &&
    Array.isArray(snapshot.lists) &&
    typeof snapshot.details === 'object' &&
    snapshot.details !== null
  );
}

export class ReadCache {
  constructor(
    private readonly storage: CacheStorage,
    private readonly key: string = STORAGE_KEY,
  ) {}

  /**
   * The saved copy for `uid`, or null when there isn't a usable one — including
   * when the device was last used by somebody else.
   */
  read(uid: string): CachedSnapshot | null {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isSnapshot(parsed) && parsed.uid === uid ? parsed : null;
    } catch {
      return null;
    }
  }

  write(snapshot: Omit<CachedSnapshot, 'version'>): void {
    // A list you have left shouldn't linger on the device as tasks nothing can
    // reach, so details are kept only for lists still on the account.
    const details: Record<string, ListDetail> = {};
    for (const list of snapshot.lists) {
      const detail = snapshot.details[list.id];
      if (detail) details[list.id] = detail;
    }

    try {
      this.storage.setItem(
        this.key,
        JSON.stringify({ ...snapshot, version: CACHE_VERSION, details }),
      );
    } catch {
      // Private browsing, or storage full. Opening offline next time is a
      // nicety; taking the session down over it is not.
    }
  }

  /** Sign-out. Removes the key rather than emptying it — nothing is left behind. */
  clear(): void {
    try {
      this.storage.removeItem(this.key);
    } catch {
      // Nothing sensible to do, and nothing that depends on it succeeding.
    }
  }
}

const noStorage: CacheStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** The app's one cache. Tests build their own against a fake storage. */
export const readCache = new ReadCache(
  typeof window === 'undefined' ? noStorage : window.localStorage,
);

/**
 * When the data on screen last matched the server, and whose data it is.
 *
 * The uid travels with the timestamp rather than being read from a closure at
 * write time: a fetch is tagged with the account it was made under, so nothing
 * downstream has to trust that the signed-in account hasn't changed since.
 */
export interface SavedMark {
  uid: string;
  at: number;
}

/** The timestamp, but only for the account it actually belongs to. */
export function savedAtFor(saved: SavedMark | null, uid: string | null): number | null {
  return saved && saved.uid === uid ? saved.at : null;
}

/**
 * What should be written to disk for `uid`, or null when nothing should be.
 *
 * The refusal that matters is the last one. React schedules the sign-out wipe
 * and this write in the same commit, and an effect sees the state from the
 * commit it was scheduled in — so on a straight A → B account switch this would
 * otherwise run with B's uid and A's still-unwiped lists, and hand them back on
 * B's next launch. Comparing the owner carried by the data catches that; a
 * guard derived from `uid` alone is a commit behind the thing it protects.
 */
export function snapshotToPersist(
  uid: string | null,
  me: Me | null,
  saved: SavedMark | null,
  lists: ListSummary[],
  details: Record<string, ListDetail>,
): Omit<CachedSnapshot, 'version'> | null {
  if (!uid || !me) return null;
  const savedAt = savedAtFor(saved, uid);
  if (savedAt === null) return null;
  return { uid, me, savedAt, lists, details };
}

/** Period keys are computed server-side; all a device can tell is that its own has run out. */
function periodHasPassed(resetsAt: string | null, now: number): boolean {
  if (!resetsAt) return false; // cadence 'none' — a plain checklist that never clears
  const endsAt = new Date(resetsAt).getTime();
  return Number.isFinite(endsAt) && endsAt <= now;
}

function clearEndedPeriod(detail: ListDetail, now: number): ListDetail {
  if (!periodHasPassed(detail.resetsAt, now)) return detail;
  return {
    ...detail,
    doneCount: 0,
    tasks: detail.tasks.map((task) => (task.completion ? { ...task, completion: null } : task)),
  };
}

/**
 * Queued ticks set the completion outright rather than adjusting a counter.
 * The optimistic tick is already in the saved copy, so anything that added to
 * a count here would show the cat as fed twice.
 */
function applyTicks(detail: ListDetail, ticks: PendingTick[], me: UserRef): ListDetail {
  const queued = new Map(
    ticks.filter((tick) => tick.listId === detail.id).map((tick) => [tick.taskId, tick]),
  );
  if (queued.size === 0) return detail;

  const tasks = detail.tasks.map((task) => {
    const tick = queued.get(task.id);
    if (!tick) return task;
    return {
      ...task,
      completion:
        tick.action === 'complete' ? { at: new Date(tick.at).toISOString(), by: me } : null,
    };
  });

  return { ...detail, tasks, doneCount: tasks.filter((task) => task.completion).length };
}

/**
 * Rebuilds the state the app should open with.
 *
 * Completions belonging to a period that has since ended are dropped: a list
 * insisting the cat was fed when that was last night is worse than one that
 * admits it doesn't know. Ticks still sitting in the outbox are then laid back
 * over the top, because the person made them and they haven't been undone —
 * and when they do reach the server it will record them against the period
 * that is current then, which is this one.
 */
export function restoreSnapshot(
  snapshot: CachedSnapshot,
  ticks: PendingTick[],
  now: number = Date.now(),
): { lists: ListSummary[]; details: Record<string, ListDetail> } {
  const details: Record<string, ListDetail> = {};
  for (const [id, detail] of Object.entries(snapshot.details)) {
    details[id] = applyTicks(clearEndedPeriod(detail, now), ticks, snapshot.me);
  }

  const lists = snapshot.lists.map((list) => {
    const detail = details[list.id];
    // Only a saved detail knows which tasks are ticked. Without one the summary
    // keeps the count it was saved with rather than guessing at it.
    if (!detail) return periodHasPassed(list.resetsAt, now) ? { ...list, doneCount: 0 } : list;
    return { ...list, doneCount: detail.doneCount, taskCount: detail.taskCount };
  });

  return { lists, details };
}
