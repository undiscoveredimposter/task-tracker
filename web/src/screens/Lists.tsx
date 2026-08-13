import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LIST_EMOJI } from '@tally/shared';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { cadenceLabel, resetsInLabel } from '../lib/format';
import { api } from '../lib/api';
import {
  Avatar,
  AvatarStack,
  BottomBar,
  EmptyState,
  PlusIcon,
  ProgressBar,
  Sheet,
  Skeleton,
} from '../components/ui';

export function Lists() {
  const { me, signOut } = useAuth();
  const { lists, listsLoading, setList } = useData();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string>(LIST_EMOJI[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const detail = await api.createList({
        name,
        emoji,
        // The device's own zone is very nearly always the right guess, and it's
        // one fewer decision on the way to a working list.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setList(detail);
      setCreating(false);
      setName('');
      navigate(`/l/${detail.id}`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col">
      <div className="safe-top flex shrink-0 items-center justify-between px-5 pt-2 pb-3.5">
        <h1 className="text-2xl font-semibold tracking-tight">Your lists</h1>
        <button
          type="button"
          onClick={() => void signOut()}
          title={me?.email ?? undefined}
          aria-label="Account and sign out"
        >
          {me && <Avatar user={me} />}
        </button>
      </div>

      {listsLoading ? (
        <div className="flex flex-col gap-3 px-4">
          <Skeleton className="h-[118px]" />
          <Skeleton className="h-[118px]" />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState
          title="Nothing to keep track of yet"
          icon={
            <svg width={56} height={56} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className="text-muted">
              <rect x="4" y="3.5" width="16" height="17" rx="3" />
              <path d="M8.5 9.5l2 2 4-4.5" />
              <path d="M8.5 15.5h7" opacity={0.5} />
            </svg>
          }
        >
          Make a list for the daily stuff — feeding the cat, the dishwasher — and invite whoever
          shares it with you.
        </EmptyState>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-32">
          {lists.map((list) => (
            <Link key={list.id} to={`/l/${list.id}`} className="card block rounded-2xl p-4">
              <div className="flex items-center gap-3">
                <span className="text-[28px] leading-none">{list.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg font-semibold">{list.name}</div>
                  <div className="truncate text-xs text-muted">{cadenceLabel(list)}</div>
                </div>
                <AvatarStack users={list.members} />
              </div>
              <div className="mt-3.5 flex items-center gap-2.5">
                <ProgressBar done={list.doneCount} total={list.taskCount} />
                <span className="text-[13px] font-medium whitespace-nowrap">
                  {list.doneCount} of {list.taskCount} done
                </span>
              </div>
              <div className="mt-2 text-xs text-muted first-letter:uppercase">
                {resetsInLabel(list.resetsAt)}
              </div>
            </Link>
          ))}
        </div>
      )}

      <BottomBar>
        <button type="button" onClick={() => setCreating(true)} className="btn btn-primary w-full bg-ground">
          <PlusIcon />
          New list
        </button>
      </BottomBar>

      {creating && (
        <Sheet title="New list" onClose={() => setCreating(false)}>
          <form onSubmit={create} className="flex flex-col gap-3">
            <label className="text-xs font-medium text-muted" htmlFor="list-name">
              Name
            </label>
            <input
              id="list-name"
              autoFocus
              required
              maxLength={80}
              placeholder="Home"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="field"
            />
            <span className="text-xs font-medium text-muted">Emoji</span>
            <div className="flex flex-wrap gap-2">
              {LIST_EMOJI.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setEmoji(option)}
                  aria-pressed={emoji === option}
                  className={`size-12 rounded-2xl text-[22px] ${
                    emoji === option ? 'border-[1.5px] border-accent bg-tint' : 'border border-divider bg-surface'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary mt-1">
              {busy ? 'Creating…' : 'Create list'}
            </button>
            <p className="text-xs leading-relaxed text-muted">
              It starts as a daily list resetting at 4am. You can change that in settings.
            </p>
          </form>
        </Sheet>
      )}
    </div>
  );
}
