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

/* ── Moving a task ───────────────────────────────────────────────────────── */

const place = (position: number, count: number): string => `${position} of ${count}`;

/**
 * The drag handle's name.
 *
 * It carries the row's place in the list because that is the one thing a move
 * changes, and on a handle reached with the Tab key there is nothing else
 * saying where the row currently is.
 */
export function reorderHandleLabel(title: string, position: number, count: number): string {
  return `Reorder ${title}, ${place(position, count)}`;
}

/**
 * How to start, attached to the handle itself.
 *
 * A drag is unreachable without a pointer, and a keyboard route nobody is told
 * about is unreachable in the same way — so the way in is part of the control.
 */
export const REORDER_HINT = 'Press Enter to lift this task, then use the arrow keys to move it.';

/** The row is now in the air, and here are both ways back down. */
export function liftedAnnouncement(title: string, position: number, count: number): string {
  return `${title} lifted, ${place(position, count)}. Arrow keys move it, Enter drops it, Escape puts it back.`;
}

/** Each step of the way. The rows on screen slide; this is that, said aloud. */
export function movingAnnouncement(title: string, position: number, count: number): string {
  return `${title}, ${place(position, count)}`;
}

export function droppedAnnouncement(title: string, position: number, count: number): string {
  return `${title} dropped, ${place(position, count)}.`;
}

/** Escape is only worth pressing if it says what it put back, and where. */
export function moveCancelledAnnouncement(title: string, position: number, count: number): string {
  return `${title} put back, ${place(position, count)}.`;
}

/* The refusal that undoes a move is not announced from here: it is shown in the
   app's error line, which is a `role="alert"`, so a second spoken copy would be
   the same sentence said twice. */

/* The network state is announced too, but its wording is `offlineLabel` in
   format.ts — the banner shows the same sentence, and a second implementation
   here drifted from it the moment the offline cache started saying how old the
   copy was. One state, one sentence, said once. */

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
