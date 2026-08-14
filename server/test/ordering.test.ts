import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_GAP,
  planMove,
  type MovePlan,
  type MoveRefusal,
  type MoveTarget,
  type OrderedTask,
} from '../src/ordering.ts';

/**
 * `ordering.ts` deliberately imports nothing, so this runs with no database and
 * no environment — which is what lets it cover the awkward float cases in bulk.
 */

/** Three tasks a gap apart, the state a freshly built list is in. */
const list = (): OrderedTask[] => [
  { id: 'a', position: 1 },
  { id: 'b', position: 2 },
  { id: 'c', position: 3 },
];

/** The plan, asserting the move was allowed. */
function plan(tasks: OrderedTask[], taskId: string, target: MoveTarget): MovePlan {
  const outcome = planMove(tasks, taskId, target);
  assert.ok(outcome.ok, `expected the move to be allowed, got ${JSON.stringify(outcome)}`);
  return outcome.plan;
}

/** The refusal, asserting the move was not allowed. */
function refusal(tasks: OrderedTask[], taskId: string, target: MoveTarget): MoveRefusal {
  const outcome = planMove(tasks, taskId, target);
  assert.equal(outcome.ok, false, 'expected the move to be refused, but it was allowed');
  return (outcome as { ok: false; refusal: MoveRefusal }).refusal;
}

/** Applies a plan to `tasks` and returns the resulting order, as SQL would. */
function apply(tasks: OrderedTask[], taskId: string, target: MoveTarget): OrderedTask[] {
  const applied = plan(tasks, taskId, target);
  const next = tasks.map((task) => {
    const write = applied.writes.find((candidate) => candidate.id === task.id);
    return write ? { ...task, position: write.position } : task;
  });
  next.sort((x, y) => x.position - y.position);

  // The order the plan promised and the order the positions produce must agree,
  // or the client and the next read of the list would disagree about the list.
  assert.deepEqual(
    next.map((task) => task.id),
    applied.order,
    'plan.order must match the order the written positions sort into',
  );
  return next;
}

const ids = (tasks: OrderedTask[]) => tasks.map((task) => task.id);

describe('planMove', () => {
  describe('the three moves a drag can make', () => {
    it('moves a task to the top', () => {
      assert.deepEqual(ids(apply(list(), 'c', { before: 'a' })), ['c', 'a', 'b']);
    });

    it('moves a task to the bottom', () => {
      assert.deepEqual(ids(apply(list(), 'a', { after: 'c' })), ['b', 'c', 'a']);
    });

    it('moves a task between two others', () => {
      assert.deepEqual(ids(apply(list(), 'a', { after: 'b', before: 'c' })), ['b', 'a', 'c']);
    });

    it('takes either neighbour on its own to mean the same slot', () => {
      const both = ids(apply(list(), 'a', { after: 'b', before: 'c' }));
      assert.deepEqual(ids(apply(list(), 'a', { after: 'b' })), both);
      assert.deepEqual(ids(apply(list(), 'a', { before: 'c' })), both);
    });

    it('leaves the other tasks alone', () => {
      assert.deepEqual(plan(list(), 'a', { after: 'b', before: 'c' }).writes, [
        { id: 'a', position: 2.5 },
      ]);
    });

    it('is a no-op when the task is already in that slot', () => {
      assert.deepEqual(ids(apply(list(), 'b', { after: 'a', before: 'c' })), ['a', 'b', 'c']);
    });

    it('handles a two-task list, in both directions', () => {
      const pair: OrderedTask[] = [
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
      ];
      assert.deepEqual(ids(apply(pair, 'b', { before: 'a' })), ['b', 'a']);
      assert.deepEqual(ids(apply(pair, 'a', { after: 'b' })), ['b', 'a']);
    });

    it('keeps its footing over a long run of moves', () => {
      let tasks: OrderedTask[] = [
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 3 },
        { id: 'd', position: 4 },
        { id: 'e', position: 5 },
      ];
      // Rotate the head to the tail five times: back where it started.
      for (let i = 0; i < 5; i++) {
        const head = tasks[0]!.id;
        const tail = tasks[tasks.length - 1]!.id;
        tasks = apply(tasks, head, { after: tail });
      }
      assert.deepEqual(ids(tasks), ['a', 'b', 'c', 'd', 'e']);
    });
  });

  describe('renumbering, when the gap runs out', () => {
    it('does not renumber while there is still room', () => {
      assert.equal(plan(list(), 'a', { after: 'b', before: 'c' }).renumbered, false);
    });

    it('renumbers once the neighbours are closer than the minimum gap', () => {
      const tight: OrderedTask[] = [
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 2 + MIN_GAP / 2 },
      ];
      const tightened = plan(tight, 'a', { after: 'b', before: 'c' });

      assert.equal(tightened.renumbered, true);
      assert.deepEqual(tightened.order, ['b', 'a', 'c']);
      assert.deepEqual(tightened.writes, [
        { id: 'b', position: 1 },
        { id: 'a', position: 2 },
        { id: 'c', position: 3 },
      ]);
    });

    it('renumbers rather than tying two tasks on the same position', () => {
      const tied: OrderedTask[] = [
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 2 },
      ];
      assert.equal(plan(tied, 'a', { after: 'b', before: 'c' }).renumbered, true);
    });

    it('survives repeated midpoints into the same gap, and keeps the order', () => {
      let tasks = list();
      let renumbers = 0;

      // Each pass drops the current second task back between the other two,
      // which halves the remaining gap. Well past the ~20 it takes to cross
      // MIN_GAP, so this asserts the recovery and not just the first stumble.
      for (let i = 0; i < 200; i++) {
        const moving = tasks[0]!.id;
        const target = { after: tasks[1]!.id, before: tasks[2]!.id };
        if (plan(tasks, moving, target).renumbered) renumbers++;
        tasks = apply(tasks, moving, target);

        // Every task keeps a distinct position, so the order never depends on
        // the created_at tiebreak.
        const positions = new Set(tasks.map((task) => task.position));
        assert.equal(positions.size, tasks.length, `positions collided on pass ${i}`);
        assert.equal(tasks.length, 3);
      }

      assert.ok(renumbers > 0, 'expected the run to have exhausted the gap at least once');
      // 200 passes of "move the first task into the middle" is an even number of
      // swaps of the leading pair, so c is last and a leads.
      assert.deepEqual(ids(tasks), ['a', 'b', 'c']);
    });

    it('renumbers to whole numbers a gap apart', () => {
      const tight: OrderedTask[] = [
        { id: 'a', position: 0.5 },
        { id: 'b', position: 0.5 + MIN_GAP / 4 },
        { id: 'c', position: 9 },
      ];
      assert.deepEqual(plan(tight, 'c', { after: 'a', before: 'b' }).writes, [
        { id: 'a', position: 1 },
        { id: 'c', position: 2 },
        { id: 'b', position: 3 },
      ]);
    });
  });

  describe('moving to an end never loses precision', () => {
    it('keeps a full gap when repeatedly moved to the top', () => {
      let tasks = list();
      for (let i = 0; i < 100; i++) tasks = apply(tasks, tasks[2]!.id, { before: tasks[0]!.id });
      assert.equal(tasks[1]!.position - tasks[0]!.position, 1);
    });

    it('keeps a full gap when repeatedly moved to the bottom', () => {
      let tasks = list();
      for (let i = 0; i < 100; i++) tasks = apply(tasks, tasks[0]!.id, { after: tasks[2]!.id });
      assert.equal(tasks[2]!.position - tasks[1]!.position, 1);
    });
  });

  describe('what it refuses', () => {
    it('refuses a request that names no neighbour at all', () => {
      assert.equal(refusal(list(), 'a', {}), 'no_target');
      assert.equal(refusal(list(), 'a', { after: null, before: null }), 'no_target');
    });

    it('refuses to move a task relative to itself', () => {
      assert.equal(refusal(list(), 'a', { after: 'a' }), 'self');
      assert.equal(refusal(list(), 'a', { before: 'a' }), 'self');
    });

    it('refuses a neighbour that is not in this list', () => {
      // The route turns this into a 404, not a 400: a task id from another list
      // must look exactly like one that was never real.
      assert.equal(refusal(list(), 'a', { after: 'elsewhere' }), 'unknown_task');
      assert.equal(refusal(list(), 'a', { before: 'elsewhere' }), 'unknown_task');
      assert.equal(refusal(list(), 'a', { after: 'b', before: 'elsewhere' }), 'unknown_task');
    });

    it('refuses when the task being moved is not in the list', () => {
      assert.equal(refusal(list(), 'gone', { after: 'a' }), 'unknown_task');
    });

    it('refuses a stale pair that is no longer adjacent', () => {
      assert.equal(refusal(list(), 'a', { after: 'b', before: 'b' }), 'stale_order');

      const four: OrderedTask[] = [...list(), { id: 'd', position: 4 }];
      assert.equal(refusal(four, 'a', { after: 'b', before: 'd' }), 'stale_order');
    });

    it('refuses a pair given back to front', () => {
      assert.equal(refusal(list(), 'a', { after: 'c', before: 'b' }), 'stale_order');
    });

    it('refuses before it inspects anything, so a bad body never renumbers', () => {
      const tight: OrderedTask[] = [
        { id: 'a', position: 1 },
        { id: 'b', position: 2 },
        { id: 'c', position: 2 + MIN_GAP / 2 },
      ];
      assert.equal(refusal(tight, 'a', {}), 'no_target');
      assert.equal(refusal(tight, 'a', { after: 'a' }), 'self');
    });
  });
});
