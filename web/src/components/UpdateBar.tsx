import { useSyncExternalStore } from 'react';
import { updates } from '../lib/serviceWorker';
import { CheckIcon, CloseIcon, UpdateIcon } from './ui';

/**
 * Says when a new build is waiting, and applies it on a tap.
 *
 * Sits in the layout rather than floating over it: a phone already spends its
 * bottom edge on the primary action and the undo toast, and this is the least
 * urgent of the three. Taking real space pushes those up instead of covering
 * them, and costs nothing the rest of the time, when it renders nothing at all.
 */
export function UpdateBar() {
  const state = useSyncExternalStore(updates.subscribe, updates.snapshot);

  if (state === 'idle') return null;

  // Full width in thumb reach on a phone; from md: up it hugs its content
  // rather than stretching a two-word message across the whole column.
  const shell =
    'card anim-toast mx-4 mb-[calc(env(safe-area-inset-bottom)+12px)] flex shrink-0 items-center rounded-2xl md:mx-auto md:w-fit';

  if (state === 'offline-ready') {
    return (
      <div role="status" className={`${shell} min-h-11 gap-2.5 px-4 py-2.5 text-[13px] font-medium`}>
        <CheckIcon size={14} className="shrink-0 text-accent" />
        Tally is ready to work offline.
      </div>
    );
  }

  const updating = state === 'updating';

  return (
    <div role="status" className={`${shell} min-h-14 gap-2.5 py-2 pr-2 pl-4`}>
      <UpdateIcon />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">New version ready</span>
      <button
        type="button"
        onClick={updates.apply}
        disabled={updating}
        className="tap inline-flex shrink-0 items-center rounded-xl border-[1.5px] border-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-60"
      >
        {updating ? 'Reloading…' : 'Reload'}
      </button>
      {/* Nothing to dismiss once the reload is on its way, and dropping it here
          keeps the row on one line at 375px. */}
      {!updating && (
        <button
          type="button"
          onClick={updates.dismiss}
          aria-label="Not now"
          className="flex size-11 shrink-0 items-center justify-center text-muted"
        >
          <CloseIcon size={18} />
        </button>
      )}
    </div>
  );
}
