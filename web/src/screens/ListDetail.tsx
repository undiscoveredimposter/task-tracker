import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { roleAtLeast, type Task } from '@tally/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { resetsInLabel } from '../lib/format';
import { TaskRow } from '../components/TaskRow';
import {
  BackIcon,
  BottomBar,
  CheckIcon,
  EmptyState,
  ListSkeleton,
  OfflineBanner,
  PlusIcon,
  ProgressBar,
  Sheet,
  TrashIcon,
} from '../components/ui';

/** How long the undo stays on screen after a tick. */
const UNDO_SECONDS = 6;

export function ListDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const { getList, loadList, setList, toggleTask, online, pending, savedAt } = useData();

  const list = getList(id);
  const [justDone, setJustDone] = useState<Task | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [adding, setAdding] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void loadList(id).then((detail) => setLoadFailed(!detail));
  }, [id, loadList]);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  if (!list) {
    return loadFailed ? (
      <div className="safe-top flex h-full flex-col px-5">
        <Link to="/" aria-label="Back" className="-ml-3 flex size-11 items-center justify-center text-accent-ink">
          <BackIcon />
        </Link>
        {/* Offline, "isn't here" only means this device never saved a copy of it. */}
        <EmptyState title={online ? "That list isn't here" : 'Not saved on this device'}>
          {online
            ? 'It may have been deleted, or you may no longer be a member.'
            : "You're offline, and this list hasn't been opened on this device yet. It'll be here once you're back."}
        </EmptyState>
      </div>
    ) : (
      <ListSkeleton />
    );
  }

  const canEdit = roleAtLeast(list.role, 'editor');
  const isOwner = list.role === 'owner';

  const onToggle = (task: Task) => {
    toggleTask(list.id, task);

    clearTimeout(undoTimer.current);
    if (task.completion) {
      // Un-ticking needs no undo — the row itself already shows the change.
      setJustDone(null);
      return;
    }
    setJustDone(task);
    undoTimer.current = setTimeout(() => setJustDone(null), UNDO_SECONDS * 1000);
  };

  const undo = () => {
    if (!justDone) return;
    const current = list.tasks.find((task) => task.id === justDone.id);
    if (current?.completion) toggleTask(list.id, current);
    setJustDone(null);
    clearTimeout(undoTimer.current);
  };

  const addTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return;
    const detail = await api.addTask(list.id, { title, notes: String(form.get('notes') ?? '') || null });
    setList(detail);
    setAdding(false);
  };

  const saveTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    await api.updateTask(editing.id, {
      title: String(form.get('title') ?? '').trim(),
      notes: String(form.get('notes') ?? '') || null,
    });
    setEditing(null);
    await loadList(list.id);
  };

  const deleteTask = async () => {
    if (!editing) return;
    await api.deleteTask(editing.id);
    setEditing(null);
    await loadList(list.id);
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="safe-top shrink-0 px-4 pt-1 pb-3">
        <div className="flex items-center gap-1.5">
          <Link to="/" aria-label="Back to your lists" className="-ml-3 flex size-11 items-center justify-center text-accent-ink">
            <BackIcon />
          </Link>
          <span className="text-[22px] leading-none">{list.emoji}</span>
          <h1 className="truncate text-[22px] font-semibold tracking-tight">{list.name}</h1>
          <span className="ml-auto shrink-0 text-[13px] text-muted">{resetsInLabel(list.resetsAt)}</span>
        </div>

        <div className="mt-2.5 flex items-center gap-2.5 pl-1">
          <ProgressBar done={list.doneCount} total={list.taskCount} />
          <span className="text-[13px] font-medium whitespace-nowrap">
            {list.doneCount} of {list.taskCount} done
          </span>
        </div>

        <div className="mt-2 flex gap-1.5 pl-1 text-[13px]">
          <Link to={`/l/${list.id}/stats`} className="tap flex items-center text-accent-ink underline underline-offset-[3px]">
            How it&apos;s going
          </Link>
          {isOwner && (
            <>
              <span className="tap flex items-center text-muted">·</span>
              <Link to={`/l/${list.id}/share`} className="tap flex items-center text-accent-ink underline underline-offset-[3px]">
                Share
              </Link>
              <span className="tap flex items-center text-muted">·</span>
              <Link to={`/l/${list.id}/settings`} className="tap flex items-center text-accent-ink underline underline-offset-[3px]">
                Settings
              </Link>
            </>
          )}
        </div>
      </div>

      <OfflineBanner online={online} pending={pending} savedAt={savedAt} />

      {list.tasks.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          icon={
            <svg width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <path d="M4.5 12.5l5 5 10-11" />
            </svg>
          }
        >
          {canEdit
            ? 'Add the first task — the small stuff that needs doing every day.'
            : 'The owner has not added any tasks yet.'}
        </EmptyState>
      ) : (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 pt-0.5 pb-32">
          {list.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              meId={me?.id ?? null}
              timezone={list.timezone}
              onToggle={() => onToggle(task)}
              onEdit={canEdit ? () => setEditing(task) : undefined}
            />
          ))}
        </div>
      )}

      {justDone && (
        <div
          role="status"
          className="anim-toast absolute inset-x-4 bottom-28 z-20 flex min-h-13 items-center gap-2.5 rounded-2xl bg-toast py-2 pr-2 pl-4 text-toast-ink shadow-[0_8px_24px_rgba(0,0,0,.35)]"
        >
          <CheckIcon />
          <span className="flex-1 truncate text-sm font-medium">{justDone.title} — done</span>
          <button
            type="button"
            onClick={undo}
            className="min-h-10 shrink-0 rounded-xl bg-toast-btn px-4 text-sm font-semibold text-toast-ink"
          >
            Undo
          </button>
        </div>
      )}

      {canEdit && (
        <BottomBar>
          <button type="button" onClick={() => setAdding(true)} className="btn btn-primary w-full bg-ground">
            <PlusIcon />
            Add a task
          </button>
        </BottomBar>
      )}

      {adding && (
        <Sheet title="Add a task" onClose={() => setAdding(false)}>
          <form onSubmit={addTask} className="flex flex-col gap-3">
            <label className="text-xs font-medium text-muted" htmlFor="new-title">
              Task
            </label>
            <input id="new-title" name="title" autoFocus required maxLength={140} placeholder="Feed the cat" className="field" />
            <label className="text-xs font-medium text-muted" htmlFor="new-notes">
              Notes <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id="new-notes"
              name="notes"
              maxLength={500}
              placeholder="e.g. the ferns in the bathroom too"
              className="field min-h-[72px] resize-none py-3"
            />
            <button type="submit" className="btn btn-primary mt-1">
              Add task
            </button>
          </form>
        </Sheet>
      )}

      {editing && (
        <Sheet title="Edit task" onClose={() => setEditing(null)}>
          <form onSubmit={saveTask} className="flex flex-col gap-3">
            <label className="text-xs font-medium text-muted" htmlFor="edit-title">
              Task
            </label>
            <input id="edit-title" name="title" defaultValue={editing.title} required maxLength={140} className="field" />
            <label className="text-xs font-medium text-muted" htmlFor="edit-notes">
              Notes <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id="edit-notes"
              name="notes"
              defaultValue={editing.notes ?? ''}
              maxLength={500}
              className="field min-h-[72px] resize-none py-3"
            />
            <div className="mt-1 flex gap-2.5">
              <button type="button" onClick={() => void deleteTask()} className="btn shrink-0 gap-2 px-4 text-[15px] font-medium text-danger">
                <TrashIcon />
                Delete
              </button>
              <button type="submit" className="btn btn-primary flex-1">
                Save
              </button>
            </div>
          </form>
        </Sheet>
      )}

      {/* Owners land here from the invite flow; keep a way back for everyone else. */}
      {!isOwner && (
        <button type="button" onClick={() => navigate('/')} className="sr-only">
          Back to your lists
        </button>
      )}
    </div>
  );
}
