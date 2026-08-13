import { beforeEach, describe, expect, it } from 'vitest';
import type { ListDetail, ListSummary, Me, Task } from '@tally/shared';
import {
  CACHE_VERSION,
  ReadCache,
  restoreSnapshot,
  savedAtFor,
  snapshotToPersist,
  type CachedSnapshot,
} from './cache';
import type { PendingTick } from './outbox';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  poison(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const NOW = Date.parse('2026-08-13T08:00:00Z');
const LATER_TODAY = new Date(NOW + 20 * 3_600_000).toISOString();
const EARLIER_TODAY = new Date(NOW - 4 * 3_600_000).toISOString();

const alex: Me = { id: 'alex', displayName: 'Alex', email: 'alex@example.com', photoUrl: null };
const sam = { id: 'sam', displayName: 'Sam', email: null, photoUrl: null };

const task = (id: string, completion: Task['completion'] = null): Task => ({
  id,
  listId: 'home',
  title: id,
  notes: null,
  position: 0,
  completion,
});

const home = (tasks: Task[], resetsAt: string | null = LATER_TODAY): ListDetail => ({
  id: 'home',
  name: 'Home',
  emoji: '🏠',
  color: 'blurple',
  ownerId: 'alex',
  createdAt: '2026-08-01T00:00:00.000Z',
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'Europe/London',
  resetHour: 4,
  role: 'owner',
  taskCount: tasks.length,
  doneCount: tasks.filter((item) => item.completion).length,
  periodKey: 'd:2026-08-13',
  resetsAt,
  members: [],
  tasks,
});

function summaryOf(detail: ListDetail): ListSummary {
  const { tasks, ...rest } = detail;
  void tasks;
  return rest;
}

const snapshotOf = (
  detail: ListDetail,
  savedAt = NOW - 3_600_000,
): CachedSnapshot => ({
  version: CACHE_VERSION,
  uid: 'firebase-alex',
  me: alex,
  savedAt,
  lists: [summaryOf(detail)],
  details: { [detail.id]: detail },
});

const tick = (taskId: string, action: PendingTick['action'] = 'complete'): PendingTick => ({
  taskId,
  listId: 'home',
  action,
  at: NOW - 600_000,
});

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe('ReadCache', () => {
  it('has nothing to offer before anything has been saved', () => {
    expect(new ReadCache(storage).read('firebase-alex')).toBeNull();
  });

  it('gives back the lists and tasks it was given', () => {
    const cache = new ReadCache(storage);
    const snapshot = snapshotOf(home([task('feed', { at: EARLIER_TODAY, by: sam })]));
    cache.write(snapshot);

    expect(cache.read('firebase-alex')).toEqual(snapshot);
  });

  it('survives a reload, which is the entire point of it', () => {
    new ReadCache(storage).write(snapshotOf(home([task('feed')])));
    expect(new ReadCache(storage).read('firebase-alex')?.lists).toHaveLength(1);
  });

  it('refuses a copy belonging to someone else', () => {
    // A shared tablet: whoever signs in next must not see the last person's lists.
    new ReadCache(storage).write(snapshotOf(home([task('feed')])));
    expect(new ReadCache(storage).read('firebase-sam')).toBeNull();
  });

  it('discards corrupt storage rather than failing to start', () => {
    storage.poison('tally.cache', '{not json');
    expect(new ReadCache(storage).read('firebase-alex')).toBeNull();
  });

  it('discards a copy written by an older version of the app', () => {
    const stale = { ...snapshotOf(home([task('feed')])), version: CACHE_VERSION - 1 };
    storage.poison('tally.cache', JSON.stringify(stale));
    expect(new ReadCache(storage).read('firebase-alex')).toBeNull();
  });

  it('ignores stored data of the wrong shape', () => {
    storage.poison('tally.cache', '{"nope": true}');
    expect(new ReadCache(storage).read('firebase-alex')).toBeNull();
  });

  it('keeps no detail for a list that is no longer on the account', () => {
    const cache = new ReadCache(storage);
    const snapshot = snapshotOf(home([task('feed')]));
    cache.write({ ...snapshot, lists: [] });

    expect(cache.read('firebase-alex')?.details).toEqual({});
  });

  it('leaves nothing behind when cleared', () => {
    const cache = new ReadCache(storage);
    cache.write(snapshotOf(home([task('feed')])));
    cache.clear();

    expect(cache.read('firebase-alex')).toBeNull();
    expect(storage.has('tally.cache')).toBe(false);
  });

  it('shrugs off storage refusing the write', () => {
    // Private browsing, or a full quota. Not being able to open offline later
    // is a nicety; throwing here would take the session down with it.
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    expect(() => new ReadCache(refusing).write(snapshotOf(home([task('feed')])))).not.toThrow();
  });
});

describe('restoreSnapshot', () => {
  it('opens on exactly what was saved when nothing is queued', () => {
    const detail = home([task('feed', { at: EARLIER_TODAY, by: sam }), task('bins')]);
    const restored = restoreSnapshot(snapshotOf(detail), [], NOW);

    expect(restored.details.home?.tasks.map((item) => item.id)).toEqual(['feed', 'bins']);
    expect(restored.details.home?.doneCount).toBe(1);
    expect(restored.lists[0]?.doneCount).toBe(1);
  });

  it('shows a tick made offline as done, with the time it was tapped', () => {
    const restored = restoreSnapshot(snapshotOf(home([task('feed')])), [tick('feed')], NOW);

    expect(restored.details.home?.tasks[0]?.completion).toEqual({
      at: new Date(NOW - 600_000).toISOString(),
      by: alex,
    });
    expect(restored.details.home?.doneCount).toBe(1);
  });

  it('does not double-count a queued tick the saved copy already shows', () => {
    // The optimistic tick is written to the cache *and* queued in the outbox,
    // so replaying it over the cached copy must be a no-op for the count.
    const detail = home([task('feed', { at: EARLIER_TODAY, by: alex }), task('bins')]);
    const restored = restoreSnapshot(snapshotOf(detail), [tick('feed')], NOW);

    expect(restored.details.home?.doneCount).toBe(1);
    expect(restored.lists[0]?.doneCount).toBe(1);
  });

  it('takes a queued untick back off again', () => {
    const detail = home([task('feed', { at: EARLIER_TODAY, by: alex })]);
    const restored = restoreSnapshot(snapshotOf(detail), [tick('feed', 'uncomplete')], NOW);

    expect(restored.details.home?.tasks[0]?.completion).toBeNull();
    expect(restored.details.home?.doneCount).toBe(0);
    expect(restored.lists[0]?.doneCount).toBe(0);
  });

  it('keeps the card on the lists screen in step with the list itself', () => {
    const detail = home([task('feed'), task('bins')]);
    const restored = restoreSnapshot(snapshotOf(detail), [tick('feed')], NOW);

    expect(restored.lists[0]?.doneCount).toBe(1);
    expect(restored.lists[0]?.taskCount).toBe(2);
  });

  it('leaves a summary alone when its tasks were never cached', () => {
    // Nothing on the device can say which of that list's tasks are ticked, so
    // the saved count stands rather than being guessed at.
    const snapshot = { ...snapshotOf(home([task('feed')])), details: {} };
    const restored = restoreSnapshot(snapshot, [tick('feed')], NOW);

    expect(restored.lists[0]?.doneCount).toBe(0);
    expect(restored.details).toEqual({});
  });

  it('unticks everything when the period ended while the device was offline', () => {
    // Yesterday's ticks are not today's. A checklist that says the cat was fed
    // when that was last night is worse than one that says nothing at all.
    const detail = home([task('feed', { at: EARLIER_TODAY, by: sam }), task('bins')], EARLIER_TODAY);
    const restored = restoreSnapshot(snapshotOf(detail), [], NOW);

    expect(restored.details.home?.tasks[0]?.completion).toBeNull();
    expect(restored.details.home?.doneCount).toBe(0);
    expect(restored.lists[0]?.doneCount).toBe(0);
  });

  it('keeps the tasks themselves when the period ends — only the ticks go', () => {
    const detail = home([task('feed', { at: EARLIER_TODAY, by: sam }), task('bins')], EARLIER_TODAY);
    const restored = restoreSnapshot(snapshotOf(detail), [], NOW);

    expect(restored.details.home?.tasks.map((item) => item.id)).toEqual(['feed', 'bins']);
    expect(restored.details.home?.taskCount).toBe(2);
  });

  it('still shows a queued tick after the period has rolled over', () => {
    // It has not reached the server yet, and the server will record it against
    // whatever period is current when it arrives — which is this one.
    const detail = home([task('feed', { at: EARLIER_TODAY, by: sam })], EARLIER_TODAY);
    const restored = restoreSnapshot(snapshotOf(detail), [tick('feed')], NOW);

    expect(restored.details.home?.doneCount).toBe(1);
    expect(restored.lists[0]?.doneCount).toBe(1);
  });

  it('never expires a list that does not reset', () => {
    const detail = home([task('feed', { at: EARLIER_TODAY, by: sam })], null);
    const restored = restoreSnapshot(snapshotOf(detail), [], NOW);

    expect(restored.details.home?.doneCount).toBe(1);
  });

  it('ignores queued ticks for a list it has no copy of', () => {
    const restored = restoreSnapshot(
      snapshotOf(home([task('feed')])),
      [{ taskId: 'hoover', listId: 'flat-admin', action: 'complete', at: NOW }],
      NOW,
    );

    expect(restored.details.home?.doneCount).toBe(0);
  });
});

/* The shared-tablet case the issue calls out. The timestamp names the account
   its data came from, so a write can't be misattributed to whoever is signed in
   by the time it happens. */
describe('savedAtFor', () => {
  it('gives the timestamp back when the data belongs to the account on screen', () => {
    expect(savedAtFor({ uid: 'firebase-alex', at: NOW }, 'firebase-alex')).toBe(NOW);
  });

  it('withholds it when the data was fetched under another account', () => {
    expect(savedAtFor({ uid: 'firebase-alex', at: NOW }, 'firebase-sam')).toBeNull();
  });

  it('withholds it when nobody is signed in', () => {
    expect(savedAtFor({ uid: 'firebase-alex', at: NOW }, null)).toBeNull();
  });

  it('has nothing to give before anything has matched the server', () => {
    expect(savedAtFor(null, 'firebase-alex')).toBeNull();
  });
});

describe('snapshotToPersist', () => {
  const detail = home([task('feed')]);
  const lists = [summaryOf(detail)];
  const details = { home: detail };
  const mark = { uid: 'firebase-alex', at: NOW };

  it('writes what is on screen, stamped with when it was last true', () => {
    expect(snapshotToPersist('firebase-alex', alex, mark, lists, details)).toEqual({
      uid: 'firebase-alex',
      me: alex,
      savedAt: NOW,
      lists,
      details,
    });
  });

  it("refuses to write one account's lists under another account's uid", () => {
    expect(snapshotToPersist('firebase-sam', alex, mark, lists, details)).toBeNull();
  });

  it('writes nothing while signed out', () => {
    expect(snapshotToPersist(null, alex, mark, lists, details)).toBeNull();
  });

  it('waits for the profile the copy is keyed to', () => {
    expect(snapshotToPersist('firebase-alex', null, mark, lists, details)).toBeNull();
  });

  it('does not save a screen that has never matched the server', () => {
    expect(snapshotToPersist('firebase-alex', alex, null, lists, details)).toBeNull();
  });
});
