import type { ListSummary, SpaceSummary } from '@tally/shared';

/**
 * The lists home, arranged the way the model is: one section per space.
 *
 * Two cases keep this from being a one-line `groupBy`. A space with nothing in
 * it still gets a section, because its header is the only way to reach the
 * share screen — a space you have just made and cannot find is a space you
 * cannot invite anyone to. And a list whose space is missing from `spaces`
 * still gets shown, in a trailing section of its own: that combination means a
 * saved copy is mid-refresh, and hiding somebody's lists is a worse answer than
 * showing them without a heading for a moment.
 */
export interface SpaceGroup {
  /** Null for the trailing "we don't know where these go" section. */
  space: SpaceSummary | null;
  lists: ListSummary[];
}

export function groupBySpace(spaces: SpaceSummary[], lists: ListSummary[]): SpaceGroup[] {
  const bySpace = new Map<string, ListSummary[]>();
  for (const list of lists) {
    const group = bySpace.get(list.spaceId);
    if (group) group.push(list);
    else bySpace.set(list.spaceId, [list]);
  }

  const groups: SpaceGroup[] = spaces.map((space) => ({
    space,
    lists: bySpace.get(space.id) ?? [],
  }));

  const known = new Set(spaces.map((space) => space.id));
  const orphans = lists.filter((list) => !known.has(list.spaceId));
  if (orphans.length > 0) groups.push({ space: null, lists: orphans });

  return groups;
}
