import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIN_GAP,
  SPACING,
  orderTasks,
  planMove,
  type MovePlan,
  type MoveResult,
  type OrderableTask,
} from '../src/ordering.ts';

/**
 * Reordering, without a database.
 *
 * Where a task ends up is arithmetic on `position` plus a decision about when
 * the float has run out of room between its neighbours. Both are worth testing
 * directly: the route around them is a transaction and a broadcast.
 */

const EPOCH = '2026-01-01T00:00:00.000Z';

function task(id: string, position: number, createdAt: string = EPOCH): OrderableTask {
  return { id, position, createdAt: new Date(createdAt) };
}

const ids = (tasks: OrderableTask[]): string[] => tasks.map((entry) => entry.id);

/** The plan, or a readable failure. Keeps the assertions below to one line. */
function planned(result: MoveResult): MovePlan {
  assert.equal(result.ok, true, `expected a plan, got ${result.ok ? '' : result.reason}`);
  return (result as Extract<MoveResult, { ok: true }>).plan;
}

/** Simulates what the route's SQL does, so a plan can be checked by its effect. */
function apply(tasks: OrderableTask[], plan: MovePlan): OrderableTask[] {
  const byId = new Map(tasks.map((entry) => [entry.id, { ...entry }]));
  if (plan.kind === 'set') byId.get(plan.id)!.position = plan.position;
  if (plan.kind === 'renumber') {
    for (const entry of plan.positions) byId.get(entry.id)!.position = entry.position;
  }
  return orderTasks([...byId.values()]);
}

function assertStrictlyIncreasing(tasks: OrderableTask[]): void {
  for (let i = 1; i < tasks.length; i++) {
    assert.ok(
      tasks[i]!.position > tasks[i - 1]!.position,
      `positions must be distinct and increasing, got ${tasks[i - 1]!.position} then ${tasks[i]!.position}`,
    );
  }
}

describe('orderTasks', () => {
  it('sorts by position first', () => {
    const tasks = [task('c', 3), task('a', 1), task('b', 2)];
    assert.deepEqual(ids(orderTasks(tasks)), ['a', 'b', 'c']);
  });

  it('breaks a tie on creation time, oldest first', () => {
    const tasks = [
      task('new', 1, '2026-03-01T00:00:00.000Z'),
      task('old', 1, '2026-01-01T00:00:00.000Z'),
    ];
    assert.deepEqual(ids(orderTasks(tasks)), ['old', 'new']);
  });

  it('is total: identical positions and timestamps still order by id', () => {
    // Rows created before positions were spaced out all sit at the column
    // default. Without the id the order would be whatever the heap felt like.
    const tasks = [task('c', 0), task('a', 0), task('b', 0)];
    assert.deepEqual(ids(orderTasks(tasks)), ['a', 'b', 'c']);
    assert.deepEqual(ids(orderTasks([...tasks].reverse())), ['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const tasks = [task('b', 2), task('a', 1)];
    orderTasks(tasks);
    assert.deepEqual(ids(tasks), ['b', 'a']);
  });
});

describe('planMove', () => {
  const list = () => [task('a', 1), task('b', 2), task('c', 3)];

  it('moves a task to the top', () => {
    const tasks = list();
    const plan = planned(planMove({ tasks, taskId: 'c', before: 'a' }));
    assert.deepEqual(ids(apply(tasks, plan)), ['c', 'a', 'b']);
  });

  it('moves a task to the bottom', () => {
    const tasks = list();
    const plan = planned(planMove({ tasks, taskId: 'a', after: 'c' }));
    assert.deepEqual(ids(apply(tasks, plan)), ['b', 'c', 'a']);
  });

  it('moves a task between two others', () => {
    const tasks = list();
    const plan = planned(planMove({ tasks, taskId: 'a', after: 'b', before: 'c' }));
    assert.equal(plan.kind, 'set');
    assert.deepEqual(ids(apply(tasks, plan)), ['b', 'a', 'c']);
  });

  it('takes one anchor on its own to mean the same place', () => {
    const tasks = list();
    const withBoth = planned(planMove({ tasks, taskId: 'a', after: 'b', before: 'c' }));
    const withAfter = planned(planMove({ tasks, taskId: 'a', after: 'b' }));
    const withBefore = planned(planMove({ tasks, taskId: 'a', before: 'c' }));
    assert.deepEqual(withAfter, withBoth);
    assert.deepEqual(withBefore, withBoth);
  });

  it('refuses two anchors that are not next to each other', () => {
    const tasks = [task('a', 1), task('b', 2), task('c', 3), task('d', 4)];
    const result = planMove({ tasks, taskId: 'd', after: 'a', before: 'c' });
    assert.deepEqual(result, { ok: false, reason: 'anchors_not_adjacent' });
  });

  it('ignores the moved task when judging adjacency', () => {
    // a, b, c: moving b back between a and c is a no-op, not a contradiction.
    const tasks = list();
    const result = planMove({ tasks, taskId: 'b', after: 'a', before: 'c' });
    assert.deepEqual(planned(result), { kind: 'noop' });
  });

  it('rejects an anchor that is not in the list', () => {
    const result = planMove({ tasks: list(), taskId: 'a', after: 'somebody-elses-task' });
    assert.deepEqual(result, { ok: false, reason: 'unknown_anchor' });
  });

  it('rejects a task that is not in the list', () => {
    const result = planMove({ tasks: list(), taskId: 'z', after: 'a' });
    assert.deepEqual(result, { ok: false, reason: 'unknown_task' });
  });

  it('rejects anchoring a task to itself', () => {
    assert.deepEqual(planMove({ tasks: list(), taskId: 'b', after: 'b' }), {
      ok: false,
      reason: 'anchor_is_task',
    });
    assert.deepEqual(planMove({ tasks: list(), taskId: 'b', before: 'b' }), {
      ok: false,
      reason: 'anchor_is_task',
    });
  });

  it('rejects a move with no anchor at all', () => {
    assert.deepEqual(planMove({ tasks: list(), taskId: 'b' }), { ok: false, reason: 'no_anchor' });
  });

  it('is a no-op when the task is already where it is being sent', () => {
    const tasks = list();
    assert.deepEqual(planned(planMove({ tasks, taskId: 'b', after: 'a' })), { kind: 'noop' });
    assert.deepEqual(planned(planMove({ tasks, taskId: 'a', before: 'b' })), { kind: 'noop' });
    assert.deepEqual(planned(planMove({ tasks, taskId: 'c', after: 'b' })), { kind: 'noop' });
  });

  it('keeps a single-task list alone — there is nothing to anchor to', () => {
    const tasks = [task('a', 1)];
    assert.deepEqual(planMove({ tasks, taskId: 'a', after: 'a' }), {
      ok: false,
      reason: 'anchor_is_task',
    });
  });

  it('renumbers rather than squeezing into a gap that is too small', () => {
    const tasks = [task('a', 1), task('b', 1 + MIN_GAP / 4), task('c', 3)];
    const plan = planned(planMove({ tasks, taskId: 'c', after: 'a', before: 'b' }));
    assert.equal(plan.kind, 'renumber');
    const after = apply(tasks, plan);
    assert.deepEqual(ids(after), ['a', 'c', 'b']);
    assertStrictlyIncreasing(after);
  });

  it('renumbers when neighbouring positions are identical', () => {
    // Every row at the column default, which is what pre-migration data looks like.
    const tasks = [task('a', 0), task('b', 0), task('c', 0)];
    const plan = planned(planMove({ tasks, taskId: 'c', after: 'a', before: 'b' }));
    assert.equal(plan.kind, 'renumber');
    assert.deepEqual(ids(apply(tasks, plan)), ['a', 'c', 'b']);
  });

  it('renumbers when a position is not a finite number', () => {
    const tasks = [task('a', 1), task('b', Number.NaN), task('c', 3)];
    const plan = planned(planMove({ tasks, taskId: 'c', before: 'a' }));
    assert.equal(plan.kind, 'renumber');
    assertStrictlyIncreasing(apply(tasks, plan));
  });

  it('gives a renumber every task a distinct, evenly spaced position', () => {
    const tasks = [task('a', 0), task('b', 0), task('c', 0), task('d', 0)];
    const plan = planned(planMove({ tasks, taskId: 'd', before: 'a' }));
    assert.equal(plan.kind, 'renumber');
    assert.deepEqual(
      (plan as Extract<MovePlan, { kind: 'renumber' }>).positions,
      [
        { id: 'd', position: SPACING },
        { id: 'a', position: SPACING * 2 },
        { id: 'b', position: SPACING * 3 },
        { id: 'c', position: SPACING * 4 },
      ],
    );
  });

  it('survives repeated midpoints: renumbering happens and order never corrupts', () => {
    let tasks = [task('a', 1), task('b', 2), task('c', 3), task('d', 4)];
    let renumbers = 0;

    // Always drag the bottom task to just under the top one. That halves the
    // gap below the first task every single time, which is the fastest way to
    // exhaust the float and the exact shape of a user dragging one row upwards.
    for (let round = 0; round < 60; round++) {
      const ordered = orderTasks(tasks);
      const anchor = ordered[0]!.id;
      const moving = ordered[ordered.length - 1]!.id;
      const expected = [ordered[0]!.id, moving, ...ordered.slice(1, -1).map((t) => t.id)];

      const plan = planned(planMove({ tasks, taskId: moving, after: anchor }));
      if (plan.kind === 'renumber') renumbers++;

      tasks = apply(tasks, plan);
      assert.deepEqual(ids(tasks), expected, `order broke on round ${round}`);
      assertStrictlyIncreasing(tasks);
    }

    assert.ok(renumbers > 0, 'expected the gap to run out and trigger a renumber');
  });

  it('renumbers again after a renumber, indefinitely', () => {
    // Two full cycles proves renumbering resets the headroom rather than
    // leaving the list one move away from wedging.
    let tasks = [task('a', 1), task('b', 2), task('c', 3)];
    let renumbers = 0;
    for (let round = 0; round < 200; round++) {
      const ordered = orderTasks(tasks);
      const plan = planned(
        planMove({ tasks, taskId: ordered[ordered.length - 1]!.id, after: ordered[0]!.id }),
      );
      if (plan.kind === 'renumber') renumbers++;
      tasks = apply(tasks, plan);
      assertStrictlyIncreasing(tasks);
    }
    assert.ok(renumbers >= 2, `expected repeated renumbering, saw ${renumbers}`);
  });
});
