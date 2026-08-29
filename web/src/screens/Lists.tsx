import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ListSummary } from '@tally/shared';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { cadenceLabel, resetsInLabel } from '../lib/format';
import { groupBySpace } from '../lib/grouping';
import { NewListSheet } from '../components/NewListSheet';
import { NewSpaceSheet } from '../components/NewSpaceSheet';
import {
  Avatar,
  AvatarStack,
  BottomBar,
  ChevronIcon,
  EmptyState,
  OfflineBanner,
  PlusIcon,
  ProgressBar,
  Skeleton,
} from '../components/ui';

function ListCard({ list }: { list: ListSummary }) {
  return (
    <Link to={`/l/${list.id}`} className="card block rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <span className="text-[28px] leading-none">{list.emoji}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-lg font-semibold">{list.name}</span>
            {/* Said plainly on the card, because "who can see this" is the one
                thing about a list you should never have to open it to know. */}
            {list.private && (
              <span className="shrink-0 rounded-md bg-tint2 px-1.5 py-0.5 text-[11px] font-medium text-muted">
                Private
              </span>
            )}
          </div>
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
  );
}

export function Lists() {
  const { me } = useAuth();
  const { spaces, lists, listsLoading, online, pending, savedAt } = useData();
  const [creating, setCreating] = useState(false);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const groups = groupBySpace(spaces, lists);

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
          <div className="flex flex-col gap-6 px-4">
            {groups.map((group) => (
              <section key={group.space?.id ?? 'unsorted'} className="flex flex-col gap-3">
                {group.space && (
                  // The header is the way into the space: renaming it, seeing
                  // who is in it, and the invite link all live one tap away.
                  <Link
                    to={`/s/${group.space.id}`}
                    className="tap -mx-1 flex items-center gap-2 rounded-xl px-1 py-1"
                  >
                    <span className="text-base leading-none">{group.space.emoji}</span>
                    <span className="truncate text-[13px] font-semibold tracking-wide text-muted uppercase">
                      {group.space.name}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5 text-muted">
                      <AvatarStack users={group.space.members} size={22} />
                      <ChevronIcon size={14} />
                    </span>
                  </Link>
                )}

                {group.lists.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-control px-4 py-5 text-center text-[13px] text-muted">
                    Nothing here yet. A list you make in this space is shared with everyone in it.
                  </p>
                ) : (
                  group.lists.map((list) => <ListCard key={list.id} list={list} />)
                )}
              </section>
            ))}

            <button
              type="button"
              onClick={() => setCreatingSpace(true)}
              className="tap self-start rounded-xl px-1 text-sm font-medium text-accent-ink"
            >
              + New space
            </button>
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
      {creatingSpace && <NewSpaceSheet onClose={() => setCreatingSpace(false)} />}
    </div>
  );
}
