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
 * Membership, and in particular the ways a list could be left without an owner.
 * Every one of these is a 400 rather than a silent success, because the recovery
 * from an ownerless list is a database query nobody wants to run.
 */
describe('members', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let list: SeededList;

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
    list = await createList(owner, { name: 'Home' });
    await h.join(list.id, editor.id, 'editor');
    await h.join(list.id, viewer.id, 'viewer');
  });

  const roleOf = async (userId: string) => {
    const { rows } = await h.sql.query<{ role: string }>(
      'SELECT role FROM list_members WHERE list_id = $1 AND user_id = $2',
      [list.id, userId],
    );
    return rows[0]?.role ?? null;
  };

  it('lists everyone with the owner first', async () => {
    const response = await viewer.get(`/api/lists/${list.id}/members`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.map((member: { id: string; role: string }) => member.role),
      ['owner', 'editor', 'viewer'],
    );
  });

  describe('the owner', () => {
    it('cannot be demoted', async () => {
      const response = await owner.patch(`/api/lists/${list.id}/members/${owner.id}`, {
        role: 'editor',
      });
      assert.equal(response.status, 400);
      assert.equal(await roleOf(owner.id), 'owner');
    });

    it('cannot remove themselves', async () => {
      const response = await owner.del(`/api/lists/${list.id}/members/${owner.id}`);
      assert.equal(response.status, 400);
      assert.match(response.body.error, /delete it instead|hand it over/i);
      assert.equal(await roleOf(owner.id), 'owner');
    });

    it('cannot be removed by an editor', async () => {
      const response = await editor.del(`/api/lists/${list.id}/members/${owner.id}`);
      assert.equal(response.status, 403);
      assert.equal(await roleOf(owner.id), 'owner');
    });

    it('cannot be removed by a viewer', async () => {
      const response = await viewer.del(`/api/lists/${list.id}/members/${owner.id}`);
      assert.equal(response.status, 403);
      assert.equal(await roleOf(owner.id), 'owner');
    });

    it('always has exactly one holder', async () => {
      await owner.patch(`/api/lists/${list.id}/members/${editor.id}`, { role: 'viewer' });
      const { rows } = await h.sql.query(
        `SELECT count(*)::int AS owners FROM list_members WHERE list_id = $1 AND role = 'owner'`,
        [list.id],
      );
      assert.equal(rows[0].owners, 1);
    });
  });

  describe('changing a role', () => {
    it('is the owner’s to do', async () => {
      assert.equal(
        (await owner.patch(`/api/lists/${list.id}/members/${viewer.id}`, { role: 'editor' })).status,
        204,
      );
      assert.equal(await roleOf(viewer.id), 'editor');

      // And it takes effect immediately on the next request.
      const task = await createTask(viewer, list.id, 'Bins out');
      assert.ok(task.id);
    });

    it('is refused to everyone else', async () => {
      for (const person of [editor, viewer]) {
        const response = await person.patch(`/api/lists/${list.id}/members/${viewer.id}`, {
          role: 'editor',
        });
        assert.equal(response.status, 403);
      }
    });

    it('404s for someone who is not a member', async () => {
      const outsider = await h.signIn('outsider');
      const response = await owner.patch(`/api/lists/${list.id}/members/${outsider.id}`, {
        role: 'editor',
      });
      assert.equal(response.status, 404);
    });
  });

  describe('removing someone', () => {
    it('is the owner’s to do, and revokes their access', async () => {
      assert.equal((await owner.del(`/api/lists/${list.id}/members/${viewer.id}`)).status, 204);
      assert.equal(await roleOf(viewer.id), null);
      assert.equal((await viewer.get(`/api/lists/${list.id}`)).status, 404);
    });

    it('is refused to an editor', async () => {
      assert.equal((await editor.del(`/api/lists/${list.id}/members/${viewer.id}`)).status, 403);
      assert.equal(await roleOf(viewer.id), 'viewer');
    });

    it('is allowed when it is yourself — that is leaving', async () => {
      assert.equal((await viewer.del(`/api/lists/${list.id}/members/${viewer.id}`)).status, 204);
      assert.equal(await roleOf(viewer.id), null);

      const mine = await viewer.get('/api/lists');
      assert.deepEqual(mine.body, []);
    });

    it('leaves the ticks behind when someone goes', async () => {
      const task = await createTask(owner, list.id, 'Feed the cat');
      await viewer.post(`/api/tasks/${task.id}/complete`);
      await viewer.del(`/api/lists/${list.id}/members/${viewer.id}`);

      const { rows } = await h.sql.query('SELECT completed_by FROM task_completions');
      assert.equal(rows.length, 1, 'leaving a list is not a reason to rewrite its history');
      assert.equal(rows[0].completed_by, viewer.id);
    });
  });
});
