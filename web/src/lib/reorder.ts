/**
 * The arithmetic behind dragging a task to a new place in the list.
 *
 * None of this touches the DOM. A drag is measured once when the row is picked
 * up and answered from those figures for the rest of the gesture — asking the
 * browser again mid-drag would measure rows that have already been shifted out
 * of the way, and the answer would feed back into itself. So the geometry
 * arrives here as plain numbers and leaves as plain numbers, which is also what
 * makes the parts most likely to be wrong testable without a layout engine.
 *
 * Positions are never computed here. The server owns `position`; this module
 * only ever says which two tasks a row was dropped between.
 */

/** One row, measured from the top of the scrolling column's content. */
export interface RowBox {
  top: number;
  height: number;
}

/** How close to an edge the finger has to be before the column scrolls itself. */
const EDGE = 56;

/** The fastest that self-scroll goes, in pixels per frame. */
const EDGE_SPEED = 14;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/**
 * Moves one item, taking it out before putting it back.
 *
 * Removing first is what makes the last slot reachable: with the row still in
 * place, the highest index means "above the bottom row" and nothing could ever
 * be dragged to the end of the list. It also matches how the server reads
 * `after`/`before`, so a drag lands where the preview said it would.
 */
export function moveWithin<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return next;
  next.splice(to, 0, moved);
  return next;
}

/**
 * Puts items back into the order the ids name.
 *
 * Anything the ids have never heard of keeps its place at the end rather than
 * being dropped — undoing a failed drag must not also delete the task somebody
 * else added while the row was in the air.
 */
export function orderBy<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  const rankOf = (item: T) => rank.get(item.id) ?? ids.length;
  return [...items].sort((a, b) => rankOf(a) - rankOf(b));
}

/**
 * The tasks either side of the slot `id` now sits in.
 *
 * Both are sent when both exist, which is the server's cue to check that they
 * are still next to each other. A move built on a list this device saw two
 * minutes ago is refused rather than quietly landing somewhere else.
 *
 * Null when there is nothing to describe the slot with — a list of one.
 */
export function anchorsAround(
  ids: readonly string[],
  id: string,
): { after: string | null; before: string | null } | null {
  const at = ids.indexOf(id);
  if (at < 0) return null;

  const after = at > 0 ? (ids[at - 1] ?? null) : null;
  const before = at < ids.length - 1 ? (ids[at + 1] ?? null) : null;
  return after === null && before === null ? null : { after, before };
}

/**
 * Which slot a row dragged to `top` belongs in — an index into the list with
 * the dragged row taken out, ready for `moveWithin`.
 *
 * Middle against middle, so a row has to travel its own height before it trades
 * places with a neighbour. Overlapping by a pixel would be enough on a smaller
 * threshold, and a hand that isn't quite still would shuffle the list.
 */
export function dropIndex(rows: readonly RowBox[], from: number, top: number): number {
  const dragged = rows[from];
  if (!dragged) return from;

  const middle = top + dragged.height / 2;
  let index = 0;
  for (const [at, row] of rows.entries()) {
    if (at !== from && row.top + row.height / 2 < middle) index += 1;
  }
  return index;
}

/**
 * How far every row has to move for the dragged one to land at `to`.
 *
 * Each row's new top is whatever ends up above it, rather than a single row
 * height applied to everything displaced: a done row carries an attribution
 * line and is taller than the rest, and shifting by a stand-in height would
 * leave a hole in the column wherever the heights differ.
 *
 * The dragged row gets its shift too, because a keyboard move has no finger to
 * follow. The pointer path overrides that one entry.
 */
export function shiftsFor(rows: readonly RowBox[], from: number, to: number): number[] {
  const shifts = rows.map(() => 0);
  const first = rows[0];
  if (!first) return shifts;

  const second = rows[1];
  const gap = second ? second.top - (first.top + first.height) : 0;

  let running = first.top;
  for (const index of moveWithin(
    rows.map((_, at) => at),
    from,
    to,
  )) {
    const row = rows[index];
    if (!row) continue;
    shifts[index] = running - row.top;
    running += row.height + gap;
  }
  return shifts;
}

/** Keeps the dragged row inside the column, so every slot stays reachable. */
export function clampTop(rows: readonly RowBox[], from: number, top: number): number {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const dragged = rows[from];
  if (!first || !last || !dragged) return top;
  return clamp(top, first.top, last.top + last.height - dragged.height);
}

/**
 * Where an arrow key sends the lifted row, or null when it cannot go there.
 *
 * No wrapping: a row at the top that jumps to the bottom on one more press of
 * Up is a move nobody asked for, and it is the press you make to check you have
 * reached the end.
 */
export function keyboardTarget(from: number, key: string, count: number): number | null {
  switch (key) {
    case 'ArrowUp':
      return from > 0 ? from - 1 : null;
    case 'ArrowDown':
      return from < count - 1 ? from + 1 : null;
    case 'Home':
      return from > 0 ? 0 : null;
    case 'End':
      return from < count - 1 ? count - 1 : null;
    default:
      return null;
  }
}

/**
 * How far to scroll the column this frame while a row is held near its edge.
 *
 * Without this the reachable part of a long list is whatever happens to be on
 * screen, which on a phone is about five rows.
 */
export function edgeScrollDelta(pointerY: number, top: number, bottom: number): number {
  const above = pointerY - top;
  const below = bottom - pointerY;

  if (above < EDGE) return -EDGE_SPEED * clamp((EDGE - above) / EDGE, 0, 1);
  if (below < EDGE) return EDGE_SPEED * clamp((EDGE - below) / EDGE, 0, 1);
  return 0;
}
