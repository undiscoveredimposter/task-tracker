/**
 * Where a task lands when someone drags it.
 *
 * `tasks.position` is a float so a task can be dropped between two others by
 * writing one row instead of rewriting the list. The cost is that halving a gap
 * repeatedly eventually runs out of double, so the plan below either produces a
 * single write or, when the room has gone, a renumbering of the whole list.
 *
 * Pure on purpose, and with no import of its own: the judgement calls — what
 * "between" means when the client's view is stale, and when a gap has become
 * too small to trust — are worth testing directly, and a unit test must not
 * need a `DATABASE_URL` to reach them. Refusals come back as values for the
 * route to turn into statuses.
 */

/** A task as the ordering cares about it: an id and where it currently sits. */
export interface OrderedTask {
  id: string;
  position: number;
}

/**
 * The slot the caller wants, named by the tasks on either side of it. Either
 * may be omitted — the end of the list is the missing neighbour.
 */
export interface MoveTarget {
  /** Id of the task the moved task should come immediately after. */
  after?: string | null;
  /** Id of the task the moved task should come immediately before. */
  before?: string | null;
}

export interface MovePlan {
  /** Rows to write: one normally, every task in the list after a renumber. */
  writes: OrderedTask[];
  /** True when the gap had run out and the whole list was rewritten. */
  renumbered: boolean;
  /** Task ids in their resulting order. */
  order: string[];
}

/** Why a move can't be made. The route decides what each is worth in HTTP. */
export type MoveRefusal =
  /** Neither neighbour was named, so there is no slot to aim at. */
  | 'no_target'
  /** A task was asked to be moved relative to itself. */
  | 'self'
  /** A named task isn't a live task of this list. */
  | 'unknown_task'
  /** Both neighbours were named but are no longer next to each other. */
  | 'stale_order';

export type MoveOutcome =
  | { ok: true; plan: MovePlan }
  | { ok: false; refusal: MoveRefusal };

/** Space left between tasks when appending, prepending or renumbering. */
export const POSITION_GAP = 1;

/**
 * Narrower than this and the next midpoint is no longer worth trusting, so the
 * list is renumbered instead. Deliberately far above the ULP of a double at
 * these magnitudes: reaching the real limit would mean two tasks sharing a
 * position, and the order quietly falling back to the `created_at` tiebreak.
 */
export const MIN_GAP = 1e-6;

/**
 * A position strictly between the two neighbours, or null when there is no
 * longer room for one and the list needs renumbering.
 */
function between(lower: OrderedTask | null, upper: OrderedTask | null): number | null {
  if (!lower && !upper) return POSITION_GAP;
  if (!lower) return upper!.position - POSITION_GAP;
  if (!upper) return lower.position + POSITION_GAP;

  // Written as `!(gap > MIN_GAP)` so a gap that is zero, negative or NaN — all
  // possible if two rows ever ended up sharing a position — renumbers too.
  const gap = upper.position - lower.position;
  if (!(gap > MIN_GAP)) return null;

  const midpoint = (lower.position + upper.position) / 2;
  // Belt and braces against a midpoint that rounds onto one of its own ends.
  if (!(midpoint > lower.position && midpoint < upper.position)) return null;
  return midpoint;
}

/**
 * Works out what to write to move `taskId` into the slot named by `target`.
 *
 * `tasks` must be every live task in the list, in the order the read path
 * serves them, and must include the task being moved.
 */
export function planMove(tasks: OrderedTask[], taskId: string, target: MoveTarget): MoveOutcome {
  const after = target.after ?? null;
  const before = target.before ?? null;

  if (after === null && before === null) return { ok: false, refusal: 'no_target' };
  if (after === taskId || before === taskId) return { ok: false, refusal: 'self' };
  if (!tasks.some((task) => task.id === taskId)) return { ok: false, refusal: 'unknown_task' };

  const rest = tasks.filter((task) => task.id !== taskId);

  // A neighbour that isn't in this list is `unknown_task`, which the route
  // turns into a 404 — the rule that keeps whether a *list* exists private
  // applies to its tasks too, so a task id from someone else's list must not be
  // distinguishable from a made-up one.
  const indexOf = (id: string): number => rest.findIndex((task) => task.id === id);

  const afterIndex = after === null ? -1 : indexOf(after);
  const beforeIndex = before === null ? -1 : indexOf(before);
  if ((after !== null && afterIndex < 0) || (before !== null && beforeIndex < 0)) {
    return { ok: false, refusal: 'unknown_task' };
  }

  const fromAfter = after === null ? null : afterIndex + 1;
  const fromBefore = before === null ? null : beforeIndex;

  // Both neighbours were named but they are no longer next to each other, so
  // the client is dragging against an order someone else has already changed.
  // Refusing and letting it reload beats guessing which of the two it meant.
  if (fromAfter !== null && fromBefore !== null && fromAfter !== fromBefore) {
    return { ok: false, refusal: 'stale_order' };
  }

  const index = fromBefore ?? fromAfter!;
  const lower = rest[index - 1] ?? null;
  const upper = rest[index] ?? null;

  const order = [
    ...rest.slice(0, index).map((task) => task.id),
    taskId,
    ...rest.slice(index).map((task) => task.id),
  ];

  const position = between(lower, upper);
  if (position !== null) {
    return { ok: true, plan: { writes: [{ id: taskId, position }], renumbered: false, order } };
  }

  // The gap ran out. Spread the whole list back out, in the order just settled
  // on, so the next few thousand drags have room again.
  return {
    ok: true,
    plan: {
      writes: order.map((id, i) => ({ id, position: (i + 1) * POSITION_GAP })),
      renumbered: true,
      order,
    },
  };
}
