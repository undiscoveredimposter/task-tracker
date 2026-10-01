import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Task } from '@tally/shared';
import * as a11y from './a11y';
import {
  REORDER_HINT,
  droppedAnnouncement,
  holdFocus,
  liftedAnnouncement,
  moveCancelledAnnouncement,
  movingAnnouncement,
  reorderHandleLabel,
  taskRowLabel,
  undoAnnouncement,
} from './a11y';

const SAM = { id: 'u-sam', displayName: 'Sam', email: null, photoUrl: null };
const ZONE = 'Europe/London';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  listId: 'l1',
  title: 'Feed the cat',
  notes: null,
  position: 0,
  completion: null,
  ...over,
});

/** 7:42am in Europe/London on a summer day. */
const AT = '2026-08-13T06:42:00.000Z';

describe('taskRowLabel', () => {
  it('is just the task when there is nothing else to say', () => {
    expect(taskRowLabel(task(), 'u-me', ZONE)).toBe('Feed the cat');
  });

  it('carries the notes, which are only on screen while the task is outstanding', () => {
    expect(taskRowLabel(task({ notes: 'the ferns in the bathroom too' }), 'u-me', ZONE)).toBe(
      'Feed the cat. Notes: the ferns in the bathroom too',
    );
  });

  it('names who did it and when', () => {
    const done = task({ completion: { by: SAM, at: AT } });
    expect(taskRowLabel(done, 'u-me', ZONE)).toBe('Feed the cat, done by Sam at 7:42am');
  });

  it('says "you" rather than reading your own name back to you', () => {
    const done = task({ completion: { by: SAM, at: AT } });
    expect(taskRowLabel(done, 'u-sam', ZONE)).toBe('Feed the cat, done by you at 7:42am');
  });

  it('reads the time in the list zone, so everyone sharing it hears the same thing', () => {
    const done = task({ completion: { by: SAM, at: AT } });
    expect(taskRowLabel(done, 'u-me', 'Australia/Sydney')).toBe('Feed the cat, done by Sam at 4:42pm');
  });

  it('admits when the tick has not reached the server', () => {
    const done = task({ completion: { by: SAM, at: AT } });
    expect(taskRowLabel(done, 'u-me', ZONE, true)).toBe(
      'Feed the cat, done by Sam at 7:42am, not synced yet',
    );
  });

  it('drops the notes once done, matching what the row shows', () => {
    const done = task({ notes: 'the ferns too', completion: { by: SAM, at: AT } });
    expect(taskRowLabel(done, 'u-me', ZONE)).toBe('Feed the cat, done by Sam at 7:42am');
  });

  it('leaves the state itself to aria-checked rather than saying it twice', () => {
    expect(taskRowLabel(task(), null, ZONE)).not.toMatch(/not done|unchecked/i);
  });
});

describe('undoAnnouncement', () => {
  it('says how long the undo will be there, because the toast will not', () => {
    expect(undoAnnouncement('Feed the cat', 6)).toBe(
      'Feed the cat done. Undo available for 6 seconds.',
    );
  });

  it('counts one second in the singular', () => {
    expect(undoAnnouncement('Feed the cat', 1)).toBe(
      'Feed the cat done. Undo available for 1 second.',
    );
  });
});

describe('the reordering wording', () => {
  it('names the handle with the place in the list a drag would change', () => {
    expect(reorderHandleLabel('Feed the cat', 1, 5)).toBe('Reorder Feed the cat, 1 of 5');
  });

  it('says how to start without a pointer, on the handle itself', () => {
    // The one sentence standing between a keyboard user and a feature they
    // otherwise have no way of discovering exists.
    expect(REORDER_HINT).toMatch(/arrow keys/i);
    expect(REORDER_HINT).toMatch(/Enter/);
  });

  it('says both ways back out at the moment the row comes up', () => {
    expect(liftedAnnouncement('Feed the cat', 1, 5)).toBe(
      'Feed the cat lifted, 1 of 5. Arrow keys move it, Enter drops it, Escape puts it back.',
    );
  });

  it('says where the row is now on every step, since the screen shows it moving', () => {
    expect(movingAnnouncement('Feed the cat', 3, 5)).toBe('Feed the cat, 3 of 5');
  });

  it('confirms where the row landed rather than leaving it in the air', () => {
    expect(droppedAnnouncement('Feed the cat', 3, 5)).toBe('Feed the cat dropped, 3 of 5.');
  });

  it('says where a cancelled row went back to, not merely that it was cancelled', () => {
    // Escape is only trustworthy if it tells you what it restored.
    expect(moveCancelledAnnouncement('Feed the cat', 1, 5)).toBe('Feed the cat put back, 1 of 5.');
  });
});

describe('the network wording', () => {
  /* `ui.test.ts` holds the banner's two halves to the same sentence. This holds
     the sentence to one home: a rival wording here is how they came apart last
     time, and it is invisible until someone hears the wrong thing. */
  const source = readFileSync(new URL('./a11y.ts', import.meta.url), 'utf8');

  it('stays in format.ts rather than growing a second copy here', () => {
    expect(source).not.toMatch(/Offline|waiting to sync|still to sync/);
  });

  it('is not reintroduced under another name', () => {
    expect(Object.keys(a11y).sort()).toStrictEqual([
      'REORDER_HINT',
      'droppedAnnouncement',
      'holdFocus',
      'liftedAnnouncement',
      'moveCancelledAnnouncement',
      'movingAnnouncement',
      'reorderHandleLabel',
      'taskRowLabel',
      'undoAnnouncement',
    ]);
  });
});

describe('holdFocus', () => {
  const target = (isConnected = true) => {
    let focused = 0;
    return {
      isConnected,
      focus: () => void (focused += 1),
      get count() {
        return focused;
      },
    };
  };

  it('hands focus back to whatever opened the dialog', () => {
    const trigger = target();
    const restore = holdFocus({ activeElement: trigger });
    restore();
    expect(trigger.count).toBe(1);
  });

  it('remembers the element as it was on open, not on close', () => {
    const trigger = target();
    const owner = { activeElement: trigger as { isConnected: boolean; focus?: () => void } | null };
    const restore = holdFocus(owner);
    owner.activeElement = target();
    restore();
    expect(trigger.count).toBe(1);
  });

  it('leaves focus alone when the trigger has gone', () => {
    // Deleting a task from its own sheet unmounts the row that opened it;
    // focusing a detached node drops focus on <body> and loses the reader's place.
    const trigger = target(false);
    holdFocus({ activeElement: trigger })();
    expect(trigger.count).toBe(0);
  });

  it('copes with nothing having been focused', () => {
    expect(() => holdFocus({ activeElement: null })()).not.toThrow();
  });

  it('copes with an element that cannot take focus', () => {
    expect(() => holdFocus({ activeElement: { isConnected: true } })()).not.toThrow();
  });
});
