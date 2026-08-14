/**
 * Where a task lands when someone drags it.
 *
 * `tasks.position` is a float so that dropping a row between two others is one
 * UPDATE rather than a rewrite of the whole list. The cost of that trick is that
 * the gap between two neighbours halves every time, and after enough drags there
 * is no representable number left between them. So this module makes one
 * decision — midpoint, or renumber the list — and the route applies whichever
 * came back inside a single transaction.
 *
 * Pure on purpose. The arithmetic and the give-up threshold are the parts worth
 * testing directly; the SQL around them is a lock and two statements.
 */

export interface OrderableTask {
  id: string;
  position: number;
  createdAt: Date;
}

export interface TaskPosition {
  id: string;
  position: number;
}

export interface MoveRequest {
  /** Every live task in the list, in any order. */
  tasks: OrderableTask[];
  /** The task being moved. */
  taskId: string;
  /** Put it directly above this task. */
  before?: string | null;
  /** Put it directly below this task. */
  after?: string | null;
}

export type MovePlan =
  /** Already there. Nothing to write, nothing to broadcast. */
  | { kind: 'noop' }
  /** One row moves. The common case. */
  | { kind: 'set'; id: string; position: number }
  /** The float ran out of room: every live task gets a fresh position. */
  | { kind: 'renumber'; positions: TaskPosition[] };

export type MoveRefusal =
  /** The moved task isn't in this list — archived underneath us, or not ours. */
  | 'unknown_task'
  /** The anchor isn't in this list. Same treatment: it does not exist to you. */
  | 'unknown_anchor'
  /** `before`/`after` named the task being moved. */
  | 'anchor_is_task'
  /** Both anchors given, but they don't sit either side of one slot. */
  | 'anchors_not_adjacent'
  /** Neither anchor given, so there is no slot to aim at. */
  | 'no_anchor';

export type MoveResult = { ok: true; plan: MovePlan } | { ok: false; reason: MoveRefusal };

/** Distance between positions after a renumber. */
export const SPACING = 1;

/**
 * The smallest gap we will still call usable. Well above the point where
 * `(a + b) / 2` stops landing strictly between `a` and `b`, so a renumber is
 * always a deliberate choice rather than a rescue after the order already broke.
 */
export const MIN_GAP = 1e-6;

const finite = (value: number): boolean => Number.isFinite(value);

/**
 * The order the list is displayed in. Total, not merely deterministic: position
 * has a column default so it can tie, `created_at` can tie inside one
 * transaction, and the primary key breaks anything left. The same three columns
 * are the ORDER BY in every query that reads tasks — they have to agree or a
 * move computed here lands somewhere else on screen.
 */
export function compareTasks(a: OrderableTask, b: OrderableTask): number {
  // Non-finite positions sort last rather than poisoning the comparison; the
  // move that finds one renumbers the list anyway.
  const pa = finite(a.position) ? a.position : Number.POSITIVE_INFINITY;
  const pb = finite(b.position) ? b.position : Number.POSITIVE_INFINITY;
  if (pa < pb) return -1;
  if (pa > pb) return 1;

  const ta = a.createdAt.getTime();
  const tb = b.createdAt.getTime();
  if (ta < tb) return -1;
  if (ta > tb) return 1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy. The input is left alone. */
export function orderTasks(tasks: OrderableTask[]): OrderableTask[] {
  return [...tasks].sort(compareTasks);
}

function renumber(finalOrder: OrderableTask[]): MovePlan {
  return {
    kind: 'renumber',
    positions: finalOrder.map((entry, index) => ({ id: entry.id, position: (index + 1) * SPACING })),
  };
}

/**
 * Works out what to write so that `taskId` ends up directly after `after` and/or
 * directly before `before`.
 *
 * Anchors are resolved against the tasks passed in, so a client-supplied id can
 * only ever name a task in the list it already has access to; anything else is
 * `unknown_anchor`, which the route reports as a 404.
 */
export function planMove(request: MoveRequest): MoveResult {
  const { tasks, taskId } = request;
  const before = request.before ?? null;
  const after = request.after ?? null;

  const ordered = orderTasks(tasks);
  if (!ordered.some((entry) => entry.id === taskId)) return { ok: false, reason: 'unknown_task' };
  if (before === null && after === null) return { ok: false, reason: 'no_anchor' };
  if (before === taskId || after === taskId) return { ok: false, reason: 'anchor_is_task' };

  // The moved task is taken out first, so "directly after a" means the same
  // thing whether it is currently above or below a.
  const rest = ordered.filter((entry) => entry.id !== taskId);

  let index: number | null = null;
  if (after !== null) {
    const at = rest.findIndex((entry) => entry.id === after);
    if (at < 0) return { ok: false, reason: 'unknown_anchor' };
    index = at + 1;
  }
  if (before !== null) {
    const at = rest.findIndex((entry) => entry.id === before);
    if (at < 0) return { ok: false, reason: 'unknown_anchor' };
    // Both anchors given: they have to name the same slot, or the client is
    // describing a position that doesn't exist and guessing would be worse.
    if (index !== null && index !== at) return { ok: false, reason: 'anchors_not_adjacent' };
    index = at;
  }
  if (index === null) return { ok: false, reason: 'no_anchor' };

  const moving = ordered.find((entry) => entry.id === taskId)!;
  const finalOrder = [...rest.slice(0, index), moving, ...rest.slice(index)];

  const unchanged = finalOrder.every((entry, at) => entry.id === ordered[at]!.id);
  if (unchanged) return { ok: true, plan: { kind: 'noop' } };

  // If positions aren't already distinct and increasing — ties from the column
  // default, or a non-finite value — the displayed order is leaning on the
  // tiebreaks and a midpoint has nothing meaningful to bisect. A move is a cheap
  // moment to normalise, so take it.
  const degenerate = ordered.some(
    (entry, at) => !finite(entry.position) || (at > 0 && entry.position <= ordered[at - 1]!.position),
  );
  if (degenerate) return { ok: true, plan: renumber(finalOrder) };

  const prev = index > 0 ? rest[index - 1] : undefined;
  const next = index < rest.length ? rest[index] : undefined;

  let position: number;
  if (prev && next) position = prev.position + (next.position - prev.position) / 2;
  else if (prev) position = prev.position + SPACING;
  else if (next) position = next.position - SPACING;
  else position = SPACING;

  const roomy =
    finite(position) &&
    (!prev || position - prev.position >= MIN_GAP) &&
    (!next || next.position - position >= MIN_GAP);

  return { ok: true, plan: roomy ? { kind: 'set', id: taskId, position } : renumber(finalOrder) };
}
