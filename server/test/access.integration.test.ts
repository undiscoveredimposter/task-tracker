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
 * Who may do what, checked through the HTTP surface rather than against the
 * middleware in isolation — the point is that no route quietly skips the check.
 */
describe('access control', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let list: SeededList;
  let task: { id: string };

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
    task = await createTask(owner, list.id);
  });

  describe('a signed-out caller', () => {
    it('is turned away from every list-scoped route', async () => {
      const anon = h.anonymous();
      for (const response of [
        await anon.get('/api/me'),
        await anon.get('/api/lists'),
        await anon.get(`/api/lists/${list.id}`),
        await anon.post(`/api/lists/${list.id}/tasks`, { title: 'x' }),
        await anon.post(`/api/tasks/${task.id}/complete`),
        await anon.get(`/api/lists/${list.id}/members`),
        await anon.post(`/api/lists/${list.id}/invites`, { role: 'viewer' }),
      ]) {
        assert.equal(response.status, 401);
      }
    });

    it('is turned away for a malformed token too', async () => {
      for (const token of ['dev:', 'dev::', 'dev:::']) {
        assert.equal((await h.withToken(token).get('/api/lists')).status, 401);
      }
    });

    it('never echoes the token back', async () => {
      const response = await h.withToken('dev:').get('/api/lists');
      assert.doesNotMatch(JSON.stringify(response.body), /dev:/);
    });
  });

  describe('a viewer', () => {
    it('can tick a task off', async () => {
      const response = await viewer.post(`/api/tasks/${task.id}/complete`);
      assert.equal(response.status, 200);
      assert.equal(response.body.completion.by.id, viewer.id);
    });

    it('can untick it again', async () => {
      await viewer.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await viewer.del(`/api/tasks/${task.id}/complete`)).status, 204);

      const detail = await viewer.get(`/api/lists/${list.id}`);
      assert.equal(detail.body.tasks[0].completion, null);
    });

    it('cannot add, rename or delete a task', async () => {
      assert.equal((await viewer.post(`/api/lists/${list.id}/tasks`, { title: 'Nope' })).status, 403);
      assert.equal((await viewer.patch(`/api/tasks/${task.id}`, { title: 'Nope' })).status, 403);
      assert.equal((await viewer.del(`/api/tasks/${task.id}`)).status, 403);
    });

    it('cannot change settings, invite or delete the list', async () => {
      assert.equal((await viewer.patch(`/api/lists/${list.id}`, { name: 'Nope' })).status, 403);
      assert.equal((await viewer.post(`/api/lists/${list.id}/invites`, { role: 'viewer' })).status, 403);
      assert.equal((await viewer.del(`/api/lists/${list.id}`)).status, 403);
    });

    it('is told it lacks permission, not that the list is missing', async () => {
      // 403 is right here and 404 is not: a viewer already knows the list exists.
      const response = await viewer.del(`/api/tasks/${task.id}`);
      assert.equal(response.status, 403);
      assert.match(response.body.error, /tick tasks off/);
    });
  });

  describe('an editor', () => {
    it('can add, rename and delete tasks', async () => {
      const added = await createTask(editor, list.id, 'Water the plants');
      assert.equal((await editor.patch(`/api/tasks/${added.id}`, { title: 'Water plants' })).status, 204);
      assert.equal((await editor.del(`/api/tasks/${added.id}`)).status, 204);
    });

    it('cannot invite anyone — sharing stays with the owner', async () => {
      const response = await editor.post(`/api/lists/${list.id}/invites`, { role: 'viewer' });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /owner/i);
    });

    it('cannot see or revoke the owner’s invites', async () => {
      const created = await owner.post(`/api/lists/${list.id}/invites`, { role: 'viewer' });
      assert.equal(created.status, 201);

      assert.equal((await editor.get(`/api/lists/${list.id}/invites`)).status, 403);
      assert.equal((await editor.del(`/api/invites/${created.body.id}`)).status, 403);
    });

    it('cannot change cadence, roles or delete the list', async () => {
      assert.equal((await editor.patch(`/api/lists/${list.id}`, { cadence: 'weekly' })).status, 403);
      assert.equal(
        (await editor.patch(`/api/lists/${list.id}/members/${viewer.id}`, { role: 'editor' })).status,
        403,
      );
      assert.equal((await editor.del(`/api/lists/${list.id}`)).status, 403);
    });
  });

  describe('an owner', () => {
    it('can do all of it', async () => {
      assert.equal((await owner.patch(`/api/lists/${list.id}`, { name: 'Flat' })).status, 200);
      assert.equal((await owner.post(`/api/lists/${list.id}/invites`, { role: 'editor' })).status, 201);
      assert.equal(
        (await owner.patch(`/api/lists/${list.id}/members/${viewer.id}`, { role: 'editor' })).status,
        204,
      );
      assert.equal((await owner.del(`/api/lists/${list.id}`)).status, 204);
    });
  });

  describe('a non-member', () => {
    it('gets 404 rather than 403 everywhere — whether a list exists is private', async () => {
      for (const response of [
        await stranger.get(`/api/lists/${list.id}`),
        await stranger.patch(`/api/lists/${list.id}`, { name: 'Mine now' }),
        await stranger.del(`/api/lists/${list.id}`),
        await stranger.post(`/api/lists/${list.id}/tasks`, { title: 'Mine now' }),
        await stranger.get(`/api/lists/${list.id}/members`),
        await stranger.get(`/api/lists/${list.id}/stats`),
        await stranger.get(`/api/lists/${list.id}/invites`),
        await stranger.post(`/api/lists/${list.id}/invites`, { role: 'viewer' }),
      ]) {
        assert.equal(response.status, 404);
        assert.doesNotMatch(String(response.body.error), /permission/i);
      }
    });

    it('gets 404 on someone else’s task, ticking included', async () => {
      for (const response of [
        await stranger.post(`/api/tasks/${task.id}/complete`),
        await stranger.del(`/api/tasks/${task.id}/complete`),
        await stranger.patch(`/api/tasks/${task.id}`, { title: 'Mine now' }),
        await stranger.del(`/api/tasks/${task.id}`),
      ]) {
        assert.equal(response.status, 404);
      }
    });

    it('cannot tell a list that exists from one that never did', async () => {
      const real = await stranger.get(`/api/lists/${list.id}`);
      const invented = await stranger.get('/api/lists/2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11');

      assert.equal(real.status, invented.status);
      assert.deepEqual(real.body, invented.body);
    });

    it('sees none of it in their own list index', async () => {
      const response = await stranger.get('/api/lists');
      assert.deepEqual(response.body, []);
    });

    it('is removed from the audience the moment they leave', async () => {
      await h.join(list.id, stranger.id, 'viewer');
      assert.equal((await stranger.get(`/api/lists/${list.id}`)).status, 200);

      assert.equal((await stranger.del(`/api/lists/${list.id}/members/${stranger.id}`)).status, 204);
      assert.equal((await stranger.get(`/api/lists/${list.id}`)).status, 404);
    });
  });

  describe('a malformed id', () => {
    /** Well-formed, but no such row — the answer everything below must match. */
    const MISSING = '2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11';
    const MALFORMED = ['not-a-uuid', '1', 'nope', encodeURIComponent("'; DROP TABLE tasks; --")];

    /**
     * Every route that puts a client-supplied list id into SQL. Run with a real
     * id these would mutate, so they are only ever called with an id that
     * resolves to nothing.
     */
    const listRoutes = (as: TestUser, id: string): Record<string, () => Promise<any>> => ({
      'GET /api/lists/:id': () => as.get(`/api/lists/${id}`),
      'PATCH /api/lists/:id': () => as.patch(`/api/lists/${id}`, { name: 'Mine now' }),
      'DELETE /api/lists/:id': () => as.del(`/api/lists/${id}`),
      'POST /api/lists/:id/tasks': () => as.post(`/api/lists/${id}/tasks`, { title: 'Mine now' }),
      'GET /api/lists/:id/stats': () => as.get(`/api/lists/${id}/stats`),
      'GET /api/lists/:id/members': () => as.get(`/api/lists/${id}/members`),
      'PATCH /api/lists/:id/members/:userId': () =>
        as.patch(`/api/lists/${id}/members/${MISSING}`, { role: 'editor' }),
      'DELETE /api/lists/:id/members/:userId': () => as.del(`/api/lists/${id}/members/${MISSING}`),
      'GET /api/lists/:id/invites': () => as.get(`/api/lists/${id}/invites`),
      'POST /api/lists/:id/invites': () => as.post(`/api/lists/${id}/invites`, { role: 'viewer' }),
    });

    /** The same, for the routes keyed on a task id. */
    const taskRoutes = (as: TestUser, id: string): Record<string, () => Promise<any>> => ({
      'PATCH /api/tasks/:id': () => as.patch(`/api/tasks/${id}`, { title: 'Mine now' }),
      'DELETE /api/tasks/:id': () => as.del(`/api/tasks/${id}`),
      'POST /api/tasks/:id/complete': () => as.post(`/api/tasks/${id}/complete`),
      'DELETE /api/tasks/:id/complete': () => as.del(`/api/tasks/${id}/complete`),
    });

    const inviteRoutes = (as: TestUser, id: string): Record<string, () => Promise<any>> => ({
      'DELETE /api/invites/:id': () => as.del(`/api/invites/${id}`),
    });

    const allRoutes = (as: TestUser, id: string) => ({
      ...listRoutes(as, id),
      ...taskRoutes(as, id),
      ...inviteRoutes(as, id),
    });

    /** Runs `fn` with console.error captured, so a stack trace can be asserted on. */
    async function capturingLogs(fn: () => Promise<void>): Promise<unknown[][]> {
      const original = console.error;
      const lines: unknown[][] = [];
      console.error = (...args: unknown[]) => void lines.push(args);
      try {
        await fn();
      } finally {
        console.error = original;
      }
      return lines;
    }

    it('is a 404 on every route that takes one, not a 500 from Postgres', async () => {
      for (const bad of MALFORMED) {
        for (const [route, send] of Object.entries(allRoutes(owner, bad))) {
          const response = await send();
          assert.equal(response.status, 404, `${route} with ${bad} should be 404`);
        }
      }
    });

    it('answers exactly what a well-formed id that matches nothing answers', async () => {
      const missing = allRoutes(owner, MISSING);
      const malformed = allRoutes(owner, 'not-a-uuid');

      for (const route of Object.keys(missing)) {
        const expected = await missing[route]!();
        const actual = await malformed[route]!();
        assert.equal(actual.status, expected.status, route);
        assert.deepEqual(actual.body, expected.body, route);
      }
    });

    it('is a 404 for a malformed member id on a list you do own', async () => {
      // The list resolves, so this is the second id on the path being rejected.
      const missing = await owner.patch(`/api/lists/${list.id}/members/${MISSING}`, { role: 'editor' });
      const malformed = await owner.patch(`/api/lists/${list.id}/members/not-a-uuid`, { role: 'editor' });
      assert.equal(malformed.status, 404);
      assert.deepEqual(malformed.body, missing.body);

      const missingDel = await owner.del(`/api/lists/${list.id}/members/${MISSING}`);
      const malformedDel = await owner.del(`/api/lists/${list.id}/members/not-a-uuid`);
      assert.equal(malformedDel.status, 404);
      assert.deepEqual(malformedDel.body, missingDel.body);
    });

    it('tells a non-member nothing that a malformed id would not have', async () => {
      // The three cases the 404-not-403 rule exists to flatten: an id we cannot
      // parse, an id that matches nothing, and a list that is simply not yours.
      const malformed = await stranger.get('/api/lists/not-a-uuid');
      const invented = await stranger.get(`/api/lists/${MISSING}`);
      const real = await stranger.get(`/api/lists/${list.id}`);

      assert.equal(malformed.status, 404);
      assert.equal(malformed.status, invented.status);
      assert.equal(malformed.status, real.status);
      assert.deepEqual(malformed.body, invented.body);
      assert.deepEqual(malformed.body, real.body);
    });

    it('never quotes the id back at the caller', async () => {
      const response = await owner.get('/api/lists/not-a-uuid');
      assert.doesNotMatch(JSON.stringify(response.body), /not-a-uuid/);
      assert.doesNotMatch(JSON.stringify(response.body), /uuid/i, 'no Postgres parse error either');
    });

    it('logs nothing — walking the API must not be able to fill the log', async () => {
      const lines = await capturingLogs(async () => {
        for (const send of Object.values(allRoutes(owner, 'not-a-uuid'))) await send();
      });
      assert.deepEqual(lines, [], `expected no logging, got ${JSON.stringify(lines)}`);
    });

    it('leaves the invite token alone — a token is not a uuid', async () => {
      // Same shape of input, deliberately different answer: an unknown token
      // previews as not_found rather than erroring, and that is the contract the
      // invite landing page is built on.
      const preview = await h.anonymous().get('/api/invites/token/not-a-uuid');
      assert.equal(preview.status, 200);
      assert.deepEqual(preview.body, { status: 'not_found' });

      const accept = await owner.post('/api/invites/token/not-a-uuid/accept');
      assert.equal(accept.status, 404);
    });

    it('still finds a list whose id happens to be upper case in the URL', async () => {
      // Postgres parses a uuid case-insensitively, so the guard must not be the
      // thing that turns a real list into a 404.
      const response = await owner.get(`/api/lists/${list.id.toUpperCase()}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.id, list.id);
    });
  });

  describe('request bodies', () => {
    it('are validated at the edge', async () => {
      assert.equal((await owner.post('/api/lists', {})).status, 400);
      assert.equal((await owner.post('/api/lists', { name: '   ' })).status, 400);
      assert.equal((await owner.post('/api/lists', { name: 'x', resetHour: 99 })).status, 400);
      assert.equal((await owner.post('/api/lists', { name: 'x', timezone: 'Mars/Olympus' })).status, 400);
      assert.equal((await owner.post('/api/lists', { name: 'x', cadence: 'hourly' })).status, 400);
      assert.equal((await owner.post(`/api/lists/${list.id}/tasks`, { title: '' })).status, 400);
      assert.equal(
        (await owner.patch(`/api/lists/${list.id}/members/${viewer.id}`, { role: 'owner' })).status,
        400,
        'a client must not be able to promote anyone to owner',
      );
    });

    it('cannot smuggle in an owner or a member id', async () => {
      const hijack = await owner.post('/api/lists', { name: 'Sneaky', ownerId: stranger.id });
      assert.equal(hijack.status, 201);
      assert.equal(hijack.body.ownerId, owner.id, 'ownerId must come from the token, not the body');
    });
  });
});
