import type { Task } from '@tally/shared';
import { timeOfDay } from './format';

/**
 * The half of the interface that is only ever heard.
 *
 * The wording lives here rather than in the components for the same reason the
 * date wording lives in format.ts: it is the part most likely to drift between
 * two screens, and it is the part no amount of looking at the app will check.
 */

/* ── What things are called ──────────────────────────────────────────────── */

/**
 * The whole row in one sentence: what it is, who did it, when.
 *
 * Deliberately silent about done-or-not — the row is a `checkbox`, so the state
 * arrives from `aria-checked`, and repeating it here would have every task read
 * out as "not done … not checked".
 */
export function taskRowLabel(
  task: Pick<Task, 'title' | 'notes' | 'completion'>,
  meId: string | null,
  timeZone: string,
  unsynced = false,
): string {
  if (!task.completion) {
    // Notes are on screen only while the task is outstanding; the label follows.
    return task.notes ? `${task.title}. Notes: ${task.notes}` : task.title;
  }

  const who = task.completion.by.id === meId ? 'you' : task.completion.by.displayName;
  const label = `${task.title}, done by ${who} at ${timeOfDay(task.completion.at, timeZone)}`;
  return unsynced ? `${label}, not synced yet` : label;
}

/* ── What gets announced ─────────────────────────────────────────────────── */

/**
 * The undo toast, said out loud.
 *
 * The window is part of the sentence because the toast leaves on a timer that
 * nobody watching it can see. An undo you aren't told the length of is not an
 * undo for anyone who can't see the screen.
 */
export function undoAnnouncement(title: string, seconds: number): string {
  return `${title} done. Undo available for ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

/**
 * The offline banner and the queued-tick count, in words. Null when there is
 * nothing worth saying, which is nearly always.
 *
 * The queue outlives the outage — it drains on the way back — so being online
 * with work still pending is a real state and gets its own sentence rather than
 * carrying on claiming to be offline.
 */
export function syncMessage(online: boolean, pending: number): string | null {
  const ticks = `${pending} tick${pending === 1 ? '' : 's'}`;
  if (!online) return pending > 0 ? `Offline — ${ticks} waiting to sync` : 'Offline — you can still tick things off';
  return pending > 0 ? `${ticks} still to sync` : null;
}

/* ── Where focus goes ────────────────────────────────────────────────────── */

/** The slice of an element a hand-back needs, so this is testable without a DOM. */
interface FocusTarget {
  readonly isConnected: boolean;
  focus?: () => void;
}

interface FocusOwner {
  readonly activeElement: FocusTarget | null;
}

/**
 * Remembers what had focus, and returns the function that gives it back.
 *
 * A modal takes focus on open and owes it back on close, or a keyboard user is
 * returned to the top of the document every time they cancel a sheet. Read at
 * call time rather than at hand-back, since by then focus is inside the dialog.
 */
export function holdFocus(owner: FocusOwner): () => void {
  const previous = owner.activeElement;
  return () => {
    // The trigger can be gone by the time the sheet closes — deleting a task
    // from its own editor unmounts the row that opened it. Focusing a detached
    // element silently drops focus on <body>, which loses the reader's place
    // more thoroughly than leaving it where it is.
    if (previous?.isConnected) previous.focus?.();
  };
}
