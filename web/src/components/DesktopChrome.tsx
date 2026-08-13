import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useData } from '../lib/store';
import { listSummaryLine } from '../lib/format';
import { NewListSheet } from './NewListSheet';
import { AvatarStack, PlusIcon, Skeleton, TallyMark } from './ui';

/**
 * The chrome that only exists from `md:` up.
 *
 * A phone gets one screen at a time and a bottom bar in thumb reach; that is
 * the design and none of this appears there. A laptop has room to keep every
 * list on screen, so the sidebar takes over the job of the lists-home screen
 * and switching lists costs one click instead of a round trip.
 */

/** The id of the list currently open, or null anywhere else in the app. */
function useOpenListId(): string | null {
  const { pathname } = useLocation();
  const [, section, id] = pathname.split('/');
  return section === 'l' && id ? id : null;
}

export function DesktopTopBar() {
  const { lists } = useData();
  const openId = useOpenListId();
  const open = lists.find((list) => list.id === openId);

  return (
    <header className="safe-top hidden shrink-0 border-b border-divider md:block">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <TallyMark size={22} />
        <span className="text-[15px] font-semibold tracking-tight">Tally</span>
        {open && (
          <div className="ml-auto flex items-center gap-2.5">
            <span className="text-[13px] text-muted">
              {open.members.length === 1 ? 'Just you' : `${open.members.length} people`}
            </span>
            <AvatarStack users={open.members} size={26} />
          </div>
        )}
      </div>
    </header>
  );
}

export function DesktopSidebar() {
  const { lists, listsLoading } = useData();
  const [creating, setCreating] = useState(false);

  return (
    <nav aria-label="Your lists" className="hidden w-70 shrink-0 flex-col border-r border-divider md:flex">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {listsLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-[52px]" />
            <Skeleton className="h-[52px]" />
          </div>
        ) : lists.length === 0 ? (
          <p className="px-2 py-3 text-[13px] leading-relaxed text-muted text-pretty">
            No lists yet. Make one for the daily stuff.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {lists.map((list) => (
              <li key={list.id}>
                <NavLink
                  to={`/l/${list.id}`}
                  className={({ isActive }) =>
                    `tap flex items-center gap-3 rounded-xl px-3 py-2 ${
                      isActive ? 'bg-tint' : 'hover:bg-tint2'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className="text-xl leading-none">{list.emoji}</span>
                      <span className="min-w-0 flex-1">
                        {/* The tint alone can't carry "this is the one you're
                            looking at" — the weight change says it too. */}
                        <span
                          className={`block truncate text-[15px] ${isActive ? 'font-semibold' : 'font-medium'}`}
                        >
                          {list.name}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {listSummaryLine(list)}
                        </span>
                      </span>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="safe-bottom shrink-0 border-t border-divider px-3 pt-3">
        <button type="button" onClick={() => setCreating(true)} className="btn btn-primary w-full">
          <PlusIcon />
          New list
        </button>
      </div>

      {creating && <NewListSheet onClose={() => setCreating(false)} />}
    </nav>
  );
}
