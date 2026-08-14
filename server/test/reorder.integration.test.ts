import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  SKIP_REASON,
  createList,
  createTask,
  startHarness,
  type Harness,
  type SeededList,
  type TestUser,
} from './helpers/harness.ts';

/**
 * Reordering, end to end.
 *
 * `ordering.test.ts` proves the arithmetic. What only a real database can show
 * is that the transaction writes what was planned, that the order survives a
 * round trip, and that a renumber is atomic rather than a list briefly holding
 * two tasks at the same position.
 */

interface TaskShape {
  id: string;
  title: string;
  position: number;
}

describe('reordering tasks', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let list: SeededList;
  let a: { id: string };
  let b: { id: string };
  let c: { id: string };

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.truncate();
    owner = await h.signIn('owner');
    editor = await h.signIn('editor');
    viewer = await h.signIn('viewer');
    stranger = await h.signIn('stranger');

    list = await createList(owner, { name: 'Home', timezone: 'UTC', resetHour: 4 });
    await h.join(list.id, editor.id, 'editor');
    await h.join(list.id, viewer.id, 'viewer');

    a = await createTask(owner, list.id, 'A');
    b = await createTask(owner, list.id, 'B');
    c = await createTask(owner, list.id, 'C');
  });

  /** Titles in the order the API serves them, read back rather than assumed. */
  async function order(as: TestUser = owner): Promise<string[]> {
    const response = await as.get<{ tasks: TaskShape[] }>(`/api/lists/${list.id}`);
    assert.equal(response.status, 200);
    return response.body.tasks.map((task) => task.title);
  }

  async function positions(): Promise<number[]> {
    const { rows } = await h.sql.query<{ position: number }>(
      `SELECT position FROM tasks
        WHERE list_id = $1 AND archived_at IS NULL
        ORDER BY position, created_at, id`,
      [list.id],
    );
    return rows.map((row) => row.position);
  }

  function assertStrictlyIncreasing(values: number[]): void {
    for (let i = 1; i < values.length; i++) {
      assert.ok(
        values[i]! > values[i - 1]!,
        `positions must stay distinct and increasing, got ${values[i - 1]} then ${values[i]}`,
      );
    }
  }

  it('starts in creation order', async () => {
    assert.deepEqual(await order(), ['A', 'B', 'C']);
  });

  it('moves a task to the top', async () => {
    const response = await editor.post<{ tasks: TaskShape[] }>(`/api/tasks/${c.id}/move`, {
      before: a.id,
    });
    assert.equal(response.status, 200);
    // The response is the authoritative list, so the client never has to guess.
    assert.deepEqual(
      response.body.tasks.map((task) => task.title),
      ['C', 'A', 'B'],
    );
    assert.deepEqual(await order(), ['C', 'A', 'B']);
  });

  it('moves a task to the bottom', async () => {
    assert.equal((await editor.post(`/api/tasks/${a.id}/move`, { after: c.id })).status, 200);
    assert.deepEqual(await order(), ['B', 'C', 'A']);
  });

  it('moves a task between two others', async () => {
    assert.equal(
      (await editor.post(`/api/tasks/${c.id}/move`, { after: a.id, before: b.id })).status,
      200,
    );
    assert.deepEqual(await order(), ['A', 'C', 'B']);
    assertStrictlyIncreasing(await positions());
  });

  it('takes before and after separately to mean the same slot', async () => {
    await editor.post(`/api/tasks/${c.id}/move`, { after: a.id });
    assert.deepEqual(await order(), ['A', 'C', 'B']);
    await editor.post(`/api/tasks/${c.id}/move`, { before: b.id });
    assert.deepEqual(await order(), ['A', 'C', 'B']);
  });

  it('leaves the order alone when the task is already there', async () => {
    const before = await positions();
    assert.equal((await editor.post(`/api/tasks/${b.id}/move`, { after: a.id })).status, 200);
    assert.deepEqual(await order(), ['A', 'B', 'C']);
    assert.deepEqual(await positions(), before, 'a no-op move should not rewrite positions');
  });

  it('is durable — the new order is what the next reader sees', async () => {
    await editor.post(`/api/tasks/${a.id}/move`, { after: c.id });
    // A different member, a fresh request: the order is in the database, not in
    // the response the mover happened to get back.
    assert.deepEqual(await order(viewer), ['B', 'C', 'A']);
  });

  describe('permissions', () => {
    it('lets an editor move', async () => {
      assert.equal((await editor.post(`/api/tasks/${a.id}/move`, { after: b.id })).status, 200);
    });

    it('refuses a viewer', async () => {
      const response = await viewer.post(`/api/tasks/${a.id}/move`, { after: b.id });
      assert.equal(response.status, 403);
      assert.deepEqual(await order(), ['A', 'B', 'C']);
    });

    it('tells a stranger the task does not exist, not that they lack permission', async () => {
      const response = await stranger.post(`/api/tasks/${a.id}/move`, { after: b.id });
      assert.equal(response.status, 404);
    });

    it('turns away a signed-out caller', async () => {
      assert.equal(
        (await h.anonymous().post(`/api/tasks/${a.id}/move`, { after: b.id })).status,
        401,
      );
    });
  });

  describe('bad requests', () => {
    it('rejects a move with no anchor', async () => {
      assert.equal((await editor.post(`/api/tasks/${a.id}/move`, {})).status, 400);
      assert.equal((await editor.post(`/api/tasks/${a.id}/move`)).status, 400);
    });

    it('rejects anchoring a task to itself', async () => {
      assert.equal((await editor.post(`/api/tasks/${a.id}/move`, { after: a.id })).status, 400);
    });

    it('rejects two anchors that are not next to each other', async () => {
      const d = await createTask(owner, list.id, 'D');
      const response = await editor.post(`/api/tasks/${d.id}/move`, { after: a.id, before: c.id });
      assert.equal(response.status, 400);
      assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
    });

    it('rejects an anchor that is not a task at all', async () => {
      // Not a uuid: anchors are resolved in memory against this list's own rows,
      // so a nonsense id is a 404 rather than a cast error out of Postgres.
      assert.equal(
        (await editor.post(`/api/tasks/${a.id}/move`, { after: 'not-a-task' })).status,
        404,
      );
    });

    it("hides another list's task behind the same 404", async () => {
      const other = await createList(stranger, { name: 'Theirs' });
      const theirs = await createTask(stranger, other.id, 'Theirs');
      const response = await editor.post(`/api/tasks/${a.id}/move`, { after: theirs.id });
      assert.equal(response.status, 404);
      assert.doesNotMatch(JSON.stringify(response.body), /Theirs/);
    });

    it('will not use an archived task as an anchor, or move one', async () => {
      await editor.del(`/api/tasks/${b.id}`);
      assert.equal((await editor.post(`/api/tasks/${a.id}/move`, { after: b.id })).status, 404);
      assert.equal((await editor.post(`/api/tasks/${b.id}/move`, { after: a.id })).status, 404);
    });
  });

  describe('when the float runs out of room', () => {
    it('renumbers, in one transaction, without corrupting the order', async () => {
      const d = await createTask(owner, list.id, 'D');
      const titles = new Map([
        [a.id, 'A'],
        [b.id, 'B'],
        [c.id, 'C'],
        [d.id, 'D'],
      ]);

      let renumbered = false;

      // Drag the bottom task to just under the top one, over and over. Each
      // round halves the gap below the first task, so the float is exhausted
      // within about twenty — the shape of someone reordering a list all evening.
      for (let round = 0; round < 40; round++) {
        const current = await h.sql.query<{ id: string; position: number }>(
          `SELECT id, position FROM tasks
            WHERE list_id = $1 AND archived_at IS NULL
            ORDER BY position, created_at, id`,
          [list.id],
        );
        const before = current.rows;
        const anchor = before[0]!.id;
        const moving = before[before.length - 1]!.id;
        const expected = [
          titles.get(anchor)!,
          titles.get(moving)!,
          ...before.slice(1, -1).map((row) => titles.get(row.id)!),
        ];
        const gapBefore = before[1]!.position - before[0]!.position;

        const response = await editor.post(`/api/tasks/${moving}/move`, { after: anchor });
        assert.equal(response.status, 200, `round ${round}`);

        const after = await positions();
        assert.deepEqual(await order(), expected, `order broke on round ${round}`);
        assertStrictlyIncreasing(after);

        // A renumber is visible as the gap growing back rather than halving.
        if (after[1]! - after[0]! > gapBefore) renumbered = true;
      }

      assert.ok(renumbered, 'expected a renumber once the gap ran out');
      assert.equal((await positions()).length, 4, 'no task went missing along the way');
    });

    it('normalises a list whose rows all share the column default', async () => {
      // What pre-002 data looks like: everything at 0, order decided by the
      // created_at and id tiebreaks alone.
      await h.sql.query('UPDATE tasks SET position = 0 WHERE list_id = $1', [list.id]);
      assert.deepEqual(await order(), ['A', 'B', 'C']);

      assert.equal((await editor.post(`/api/tasks/${c.id}/move`, { before: a.id })).status, 200);

      assert.deepEqual(await order(), ['C', 'A', 'B']);
      assert.deepEqual(await positions(), [1, 2, 3], 'a degenerate list should be renumbered');
    });
  });

  it('leaves an archived task out of the renumber but does not resurrect it', async () => {
    await editor.del(`/api/tasks/${b.id}`);
    await h.sql.query('UPDATE tasks SET position = 0 WHERE list_id = $1', [list.id]);

    assert.equal((await editor.post(`/api/tasks/${c.id}/move`, { before: a.id })).status, 200);

    assert.deepEqual(await order(), ['C', 'A']);
    const archived = await h.sql.query<{ position: number }>(
      'SELECT position FROM tasks WHERE id = $1',
      [b.id],
    );
    assert.equal(archived.rows[0]!.position, 0, 'an archived task is not part of the live order');
  });
});
