import { describe, expect, it } from 'vitest';
import type { ListSummary, SpaceSummary } from '@tally/shared';
import { groupBySpace } from './grouping';

const space = (id: string, name: string): SpaceSummary => ({
  id,
  name,
  emoji: '🏠',
  ownerId: 'me',
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'owner',
  listCount: 0,
  members: [],
});

const list = (id: string, spaceId: string): ListSummary => ({
  id,
  name: id,
  emoji: '🐈',
  color: '#9184d9',
  ownerId: 'me',
  spaceId,
  private: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'UTC',
  resetHour: 4,
  role: 'owner',
  taskCount: 0,
  doneCount: 0,
  periodKey: 'd:2026-01-01',
  resetsAt: null,
  members: [],
});

describe('grouping the lists home by space', () => {
  it('keeps the spaces in the order they came in', () => {
    const groups = groupBySpace(
      [space('s1', 'Home'), space('s2', 'Cabin')],
      [list('b', 's2'), list('a', 's1')],
    );

    expect(groups.map((group) => group.space?.name)).toEqual(['Home', 'Cabin']);
    expect(groups[0]!.lists.map((entry) => entry.id)).toEqual(['a']);
    expect(groups[1]!.lists.map((entry) => entry.id)).toEqual(['b']);
  });

  it('still shows a space with nothing in it', () => {
    // Its header is the only way to the share screen, so an empty space that
    // renders as nothing is a space nobody can invite anyone to.
    const groups = groupBySpace([space('s1', 'Empty')], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.lists).toEqual([]);
  });

  it('shows a list whose space it has not heard of rather than hiding it', () => {
    // A saved copy mid-refresh: the lists came back before the spaces did.
    const groups = groupBySpace([space('s1', 'Home')], [list('a', 's1'), list('stray', 'gone')]);

    expect(groups).toHaveLength(2);
    expect(groups[1]!.space).toBeNull();
    expect(groups[1]!.lists.map((entry) => entry.id)).toEqual(['stray']);
  });

  it('has nothing to say about an empty account', () => {
    expect(groupBySpace([], [])).toEqual([]);
  });
});
