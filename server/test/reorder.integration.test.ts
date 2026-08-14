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
 * Reordering, through the HTTP surface and against a real Postgres.
 *
 * The interesting parts are all below the handler — the transaction that makes
 * a renumbering atomic, and the fact that the order a client reads back is the
 * one the float positions actually sort into. A mock would only confirm what
 * `ordering.test.ts` already proves about the arithmetic.
 */
describe('reordering tasks', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let list: SeededList;
  let ids: Record<string, string>;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h?.close();
  });

  /** Titles of the list's tasks, in the order the API serves them. */
  async function order(as: TestUser = owner): Promise<string[]> {
    const response = await as.get<{ tasks: { title: string }[] }>(`/api/lists/${list.id}`);
    assert.equal(response.status, 200);
    return response.body.tasks.map((task) => task.title);
  }

  /** Raw positions straight from the table, oldest tiebreak included. */
  async function positions(): Promise<{ title: string; position: number }[]> {
    const { rows } = await h.sql.query<{ title: string; position: number }>(
      `SELECT title, position FROM tasks
        WHERE list_id = $1 AND archived_at IS NULL
        ORDER BY position, created_at`,
      [list.id],
    );
    return rows;
  }

  const move = (as: TestUser, title: string, target: Record<string, string | null>) =>
    as.post(`/api/tasks/${ids[title]}/move`, target);

  beforeEach(async () => {
    await h.truncate();
    owner = await h.signIn('owner');
    editor = await h.signIn('editor');
    viewer = await h.signIn('viewer');
    stranger = await h.signIn('stranger');

    list = await createList(owner, { name: 'Home', timezone: 'UTC', resetHour: 4 });
    await h.join(list.id, editor.id, 'editor');
    await h.join(list.id, viewer.id, 'viewer');

    ids = {};
    for (const title of ['A', 'B', 'C', 'D']) {
      ids[title] = (await createTask(owner, list.id, title)).id;
    }
    assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
  });

  describe('the three moves a drag can make', () => {
    it('moves a task to the top', async () => {
      const response = await move(owner, 'D', { before: ids.A! });
      assert.equal(response.status, 200);
      assert.deepEqual(await order(), ['D', 'A', 'B', 'C']);
    });

    it('moves a task to the bottom', async () => {
      assert.equal((await move(owner, 'A', { after: ids.D! })).status, 200);
      assert.deepEqual(await order(), ['B', 'C', 'D', 'A']);
    });

    it('moves a task between any two others', async () => {
      assert.equal((await move(owner, 'A', { after: ids.B!, before: ids.C! })).status, 200);
      assert.deepEqual(await order(), ['B', 'A', 'C', 'D']);

      assert.equal((await move(owner, 'D', { after: ids.B!, before: ids.A! })).status, 200);
      assert.deepEqual(await order(), ['B', 'D', 'A', 'C']);
    });

    it('takes one neighbour on its own', async () => {
      assert.equal((await move(owner, 'D', { after: ids.A! })).status, 200);
      assert.deepEqual(await order(), ['A', 'D', 'B', 'C']);

      assert.equal((await move(owner, 'B', { before: ids.A! })).status, 200);
      assert.deepEqual(await order(), ['B', 'A', 'D', 'C']);
    });

    it('replies with the list, so the client sees the positions it now has', async () => {
      const response = await move(owner, 'D', { before: ids.A! });
      const titles = response.body.tasks.map((task: { title: string }) => task.title);
      assert.deepEqual(titles, ['D', 'A', 'B', 'C']);
      assert.deepEqual(titles, await order());
    });

    it('leaves a moved task ticked — reordering is not a reset', async () => {
      assert.equal((await viewer.post(`/api/tasks/${ids.A}/complete`)).status, 200);
      assert.equal((await move(owner, 'A', { after: ids.D! })).status, 200);

      const response = await owner.get<{ tasks: { title: string; completion: unknown }[] }>(
        `/api/lists/${list.id}`,
      );
      const moved = response.body.tasks.find((task) => task.title === 'A');
      assert.ok(moved?.completion, 'the completion should have survived the move');
    });

    it('ignores an archived task when working out the slot', async () => {
      assert.equal((await owner.del(`/api/tasks/${ids.B}`)).status, 204);

      // B is soft-deleted, so naming A and C as neighbours is adjacent now.
      assert.equal((await move(owner, 'D', { after: ids.A!, before: ids.C! })).status, 200);
      assert.deepEqual(await order(), ['A', 'D', 'C']);
    });

    it('refuses to move a task onto a soft-deleted neighbour', async () => {
      assert.equal((await owner.del(`/api/tasks/${ids.B}`)).status, 204);
      assert.equal((await move(owner, 'A', { after: ids.B! })).status, 404);
    });
  });

  describe('when the gap runs out', () => {
    it('renumbers, and the order survives it', async () => {
      // Each pass drops the leading task back between the next two, which halves
      // the remaining gap. It takes about twenty to cross the minimum gap, so
      // this goes round more than twice — the point is that the list keeps
      // working after a renumbering, not merely that one happens.
      const PASSES = 46;
      let current = await order();
      let renumberings = 0;

      for (let pass = 0; pass < PASSES; pass++) {
        const [first, second, third] = current;
        const response = await move(owner, first!, { after: ids[second!]!, before: ids[third!]! });
        assert.equal(response.status, 200, `pass ${pass} was refused`);

        const expected = [second!, first!, ...current.slice(2)];
        current = await order();
        assert.deepEqual(current, expected, `order went wrong on pass ${pass}`);

        const rows = await positions();
        assert.equal(
          new Set(rows.map((row) => row.position)).size,
          rows.length,
          `two tasks shared a position on pass ${pass}`,
        );
        if (rows.every((row) => Number.isInteger(row.position))) renumberings++;
      }

      assert.ok(renumberings > 0, `expected a renumbering within ${PASSES} passes`);

      // Each pass swaps the leading pair and leaves the rest alone, so an even
      // number of them lands back on the order it started from.
      assert.deepEqual(current, ['A', 'B', 'C', 'D']);

      // And the list is left with room to drag into again.
      const rows = await positions();
      for (let i = 1; i < rows.length; i++) {
        assert.ok(
          rows[i]!.position - rows[i - 1]!.position >= 1e-6,
          'the list should have been spread back out',
        );
      }
    });

    it('renumbers every task in one go, not just the moved one', async () => {
      // Wedge two tasks together behind the endpoint's back, then move into the
      // gap between them and check the whole list came out clean.
      await h.sql.query('UPDATE tasks SET position = $2 WHERE id = $1', [ids.B, 1.0000000001]);
      await h.sql.query('UPDATE tasks SET position = $2 WHERE id = $1', [ids.C, 1.0000000002]);

      assert.equal((await move(owner, 'D', { after: ids.B!, before: ids.C! })).status, 200);

      const rows = await positions();
      assert.deepEqual(
        rows.map((row) => row.title),
        ['A', 'B', 'D', 'C'],
      );
      assert.deepEqual(
        rows.map((row) => row.position),
        [1, 2, 3, 4],
      );
    });
  });

  describe('who may reorder', () => {
    it('lets an editor do it', async () => {
      assert.equal((await move(editor, 'A', { after: ids.D! })).status, 200);
      assert.deepEqual(await order(), ['B', 'C', 'D', 'A']);
    });

    it('refuses a viewer with 403, and changes nothing', async () => {
      const response = await move(viewer, 'A', { after: ids.D! });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /tick tasks off/);
      assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
    });

    it('gives a non-member 404, not 403 — whether the list exists is private', async () => {
      const response = await move(stranger, 'A', { after: ids.D! });
      assert.equal(response.status, 404);
      assert.doesNotMatch(String(response.body.error), /permission/i);
      assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
    });

    it('turns a signed-out caller away', async () => {
      const response = await h.anonymous().post(`/api/tasks/${ids.A}/move`, { after: ids.D! });
      assert.equal(response.status, 401);
    });

    it('will not reorder across lists', async () => {
      const other = await createList(owner, { name: 'Work' });
      const elsewhere = await createTask(owner, other.id, 'Z');

      // A real task, owned by the same person, but not in this list — and it
      // must look exactly like an id that was never real.
      assert.equal((await move(owner, 'A', { after: elsewhere.id })).status, 404);
      assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
    });
  });

  describe('what it refuses', () => {
    it('rejects a body naming no neighbour', async () => {
      assert.equal((await move(owner, 'A', {})).status, 400);
      assert.equal((await move(owner, 'A', { after: null, before: null })).status, 400);
    });

    it('rejects a neighbour that is not a task id at all', async () => {
      assert.equal((await move(owner, 'A', { after: 'not-a-uuid' })).status, 400);
    });

    it('rejects moving a task relative to itself', async () => {
      assert.equal((await move(owner, 'A', { after: ids.A! })).status, 400);
    });

    it('rejects a stale pair that is no longer adjacent, with 409', async () => {
      const response = await move(owner, 'A', { after: ids.B!, before: ids.D! });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'stale_order');
      assert.deepEqual(await order(), ['A', 'B', 'C', 'D']);
    });

    it('never lets a refusal leave the list half-written', async () => {
      const beforeRows = await positions();
      await move(viewer, 'A', { after: ids.D! });
      await move(owner, 'A', { after: ids.B!, before: ids.D! });
      await move(owner, 'A', {});
      assert.deepEqual(await positions(), beforeRows);
    });
  });

  describe('the broadcast', () => {
    it('tells the other members the list changed', async () => {
      const stream = await openStream(viewer);
      try {
        assert.equal((await move(owner, 'A', { after: ids.D! })).status, 200);
        const event = await stream.next((frame) => frame.type === 'task.changed');
        assert.deepEqual(event, { type: 'task.changed', listId: list.id });
      } finally {
        await stream.close();
      }
    });

    it('does not echo it back to whoever did the dragging', async () => {
      const mine = await openStream(owner);
      const theirs = await openStream(editor);
      try {
        assert.equal((await move(owner, 'A', { after: ids.D! })).status, 200);

        // The mover's own UI already moved the row optimistically.
        await theirs.next((frame) => frame.type === 'task.changed');
        assert.equal(
          mine.seen().some((frame) => frame.type === 'task.changed'),
          false,
        );
      } finally {
        await mine.close();
        await theirs.close();
      }
    });

    it('does not reach someone who is not a member', async () => {
      const outside = await openStream(stranger);
      const inside = await openStream(editor);
      try {
        assert.equal((await move(owner, 'A', { after: ids.D! })).status, 200);
        await inside.next((frame) => frame.type === 'task.changed');
        assert.equal(
          outside.seen().some((frame) => frame.type === 'task.changed'),
          false,
        );
      } finally {
        await outside.close();
        await inside.close();
      }
    });
  });

  /* ── A minimal SSE reader, since Node has no EventSource ───────────────── */

  interface Frame {
    type: string;
    [key: string]: unknown;
  }

  interface Stream {
    /** Resolves with the first frame matching `wanted`, already-seen ones included. */
    next(wanted: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
    seen(): Frame[];
    close(): Promise<void>;
  }

  async function openStream(as: TestUser): Promise<Stream> {
    const controller = new AbortController();
    const response = await fetch(`${h.baseUrl}/api/stream`, {
      headers: { authorization: `Bearer dev:${as.uid}:${as.email}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    const frames: Frame[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });

          let split: number;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              frames.push(JSON.parse(line.slice(6)) as Frame);
            }
          }
        }
      } catch {
        // Aborted at the end of the test.
      }
    })();

    // The `hello` frame proves the subscriber is registered. Without waiting for
    // it a move could be broadcast before this connection is in the map, and the
    // test would fail for a reason that has nothing to do with reordering.
    const deadline = Date.now() + 5000;
    while (!frames.some((frame) => frame.type === 'hello')) {
      if (Date.now() > deadline) throw new Error('stream never said hello');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return {
      async next(wanted, timeoutMs = 5000) {
        const until = Date.now() + timeoutMs;
        for (;;) {
          const found = frames.find(wanted);
          if (found) return found;
          if (Date.now() > until) {
            throw new Error(`no matching event within ${timeoutMs}ms; saw ${JSON.stringify(frames)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
      seen: () => [...frames],
      async close() {
        controller.abort();
        await pump;
      },
    };
  }
});
