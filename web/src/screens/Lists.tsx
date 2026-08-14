import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { cadenceLabel, resetsInLabel } from '../lib/format';
import { NewListSheet } from '../components/NewListSheet';
import {
  Avatar,
  AvatarStack,
  BottomBar,
  EmptyState,
  OfflineBanner,
  PlusIcon,
  ProgressBar,
  Skeleton,
} from '../components/ui';

export function Lists() {
  const { me } = useAuth();
  const { lists, listsLoading, online, pending, savedAt } = useData();
  const [creating, setCreating] = useState(false);

  return (
    <div className="relative flex h-full flex-col">
      <div className="safe-top flex shrink-0 items-center justify-between px-5 pt-2 pb-3.5">
        <h1 className="text-2xl font-semibold tracking-tight">Your lists</h1>
        {/* The avatar is 36 and this is a control, so the link carries the 44px
            target itself rather than inheriting the avatar's size. The negative
            margin bleeds those 8px back out, leaving the header the height it
            had and the avatar where it was. */}
        <Link
          to="/settings"
          title={me?.email ?? undefined}
          aria-label="Your account"
          className="-m-1 flex size-11 items-center justify-center"
        >
          {me && <Avatar user={me} />}
        </Link>
      </div>

      {/* Outside the scroll container: whether what follows is current is the
          first thing to know about it, so it must not scroll away. */}
      <OfflineBanner online={online} pending={pending} savedAt={savedAt} />

      {/* Only the scroll container itself grows now. The branches inside it
          used to as well, to hold the appearance control against the bottom
          edge; that has moved to the account screen. `EmptyState` keeps its
          own `flex-1`, which is what centres it. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-32 md:pb-6">
        {listsLoading ? (
          <div className="flex flex-col gap-3 px-4">
            <Skeleton className="h-[118px]" />
            <Skeleton className="h-[118px]" />
          </div>
        ) : lists.length === 0 && !online && savedAt === null ? (
          // No signal and nothing saved yet — an empty account and an unreachable
          // one look identical from here, so don't claim to know which it is.
          // No icon, like the app's other "something is wrong" states.
          <EmptyState title="Nothing saved on this device">
            Your lists will be here once you have a connection again.
          </EmptyState>
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
          <div className="flex flex-col gap-3 px-4">
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
      </div>

      {/* On a desktop the sidebar already carries New list, pinned where it can
          always be reached. */}
      <BottomBar className="md:hidden">
        <button type="button" onClick={() => setCreating(true)} className="btn btn-primary w-full bg-ground">
          <PlusIcon />
          New list
        </button>
      </BottomBar>

      {creating && <NewListSheet onClose={() => setCreating(false)} />}
    </div>
  );
}
