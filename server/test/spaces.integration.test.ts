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
 * Spaces: sharing once, and having it keep applying.
 *
 * The promise the feature makes is in the first two tests — everything in a
 * space is shared with the people in it, including things put there afterwards.
 * The rest is the fine print that makes it safe to agree to: a private list is
 * nobody else's business, moving a list is its owner's decision, and leaving
 * takes your own things with you.
 */
describe('spaces', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let alex: TestUser;
  let sam: TestUser;
  let stranger: TestUser;
  let list: SeededList;
  let spaceId: string;

  before(async () => {
    h = await startHarness();
  });

  after(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.truncate();
    alex = await h.signIn('alex');
    sam = await h.signIn('sam');
    stranger = await h.signIn('stranger');
    list = await createList(alex, { name: 'Kitchen' });
    spaceId = list.spaceId;
  });

  /** Sam joins Alex's space the way a real invitee would: through a link. */
  const shareWith = async (person: TestUser, role: 'editor' | 'viewer' = 'editor') => {
    const invite = await alex.post<{ token: string }>(`/api/spaces/${spaceId}/invites`, { role });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const accepted = await person.post(`/api/invites/token/${invite.body.token}/accept`);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.spaceId, spaceId);
  };

  const idsVisibleTo = async (person: TestUser) =>
    (await person.get<{ id: string }[]>('/api/lists')).body.map((entry) => entry.id).sort();

  describe('sharing one', () => {
    it('hands over every list in it at once', async () => {
      const second = await createList(alex, { name: 'Garage' });

      await shareWith(sam);

      assert.deepEqual(await idsVisibleTo(sam), [list.id, second.id].sort());
    });

    it('keeps applying to lists that did not exist when it was shared', async () => {
      await shareWith(sam);
      // The whole point: nobody goes back and shares this one separately.
      const later = await createList(alex, { name: 'Loft' });

      const seen = await sam.get<{ id: string; role: string }[]>('/api/lists');
      const entry = seen.body.find((candidate) => candidate.id === later.id);
      assert.ok(entry, 'a list added after the invite should just be there');
      assert.equal(entry.role, 'editor', 'at the role the space was shared at');
    });

    it('gives one role across the whole space, not one per list', async () => {
      const second = await createList(alex, { name: 'Garage' });
      await shareWith(sam, 'viewer');

      for (const target of [list, second]) {
        const task = await createTask(alex, target.id);
        assert.equal((await sam.post(`/api/tasks/${task.id}/complete`)).status, 200);
        assert.equal((await sam.post(`/api/lists/${target.id}/tasks`, { title: 'no' })).status, 403);
      }
    });

    it('leaves everyone else where they were', async () => {
      await shareWith(sam);
      assert.deepEqual(await idsVisibleTo(stranger), []);
      assert.equal((await stranger.get(`/api/spaces/${spaceId}`)).status, 404);
    });
  });

  describe('a private list', () => {
    beforeEach(async () => {
      await shareWith(sam);
    });

    it('is invisible to the rest of the space', async () => {
      const secret = await createList(alex, { name: 'Presents', private: true });

      assert.deepEqual(await idsVisibleTo(sam), [list.id]);
      assert.equal((await sam.get(`/api/lists/${secret.id}`)).status, 404);
      assert.equal((await sam.get(`/api/lists/${secret.id}/stats`)).status, 404);
    });

    it('is still entirely usable by the person who made it', async () => {
      const secret = await createList(alex, { name: 'Presents', private: true });
      const task = await createTask(alex, secret.id);

      const detail = await alex.get(`/api/lists/${secret.id}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.private, true);
      assert.equal(detail.body.role, 'owner');
      assert.deepEqual(
        detail.body.members.map((member: { id: string }) => member.id),
        [alex.id],
        'a private list has an audience of one',
      );
      assert.equal((await alex.post(`/api/tasks/${task.id}/complete`)).status, 200);
    });

    it('does not show up in the space’s list count for anybody else', async () => {
      await createList(alex, { name: 'Presents', private: true });

      const mine = await alex.get(`/api/spaces/${spaceId}`);
      const theirs = await sam.get(`/api/spaces/${spaceId}`);
      assert.equal(mine.body.listCount, 2);
      assert.equal(theirs.body.listCount, 1);
    });

    it('can be made private after the fact, and the space loses sight of it', async () => {
      assert.equal((await sam.get(`/api/lists/${list.id}`)).status, 200);

      const hidden = await alex.patch(`/api/lists/${list.id}`, { private: true });
      assert.equal(hidden.status, 200);
      assert.equal(hidden.body.private, true);

      assert.equal((await sam.get(`/api/lists/${list.id}`)).status, 404);
      assert.deepEqual(await idsVisibleTo(sam), []);
    });

    it('is not something a space owner can reach into', async () => {
      // Sam is an editor here, so this is their list in Alex's space — and the
      // space belonging to Alex does not make its contents Alex's to read.
      const theirs = await sam.post('/api/lists', {
        name: 'Sam’s own',
        spaceId,
        private: true,
      });
      assert.equal(theirs.status, 201);

      assert.equal((await alex.get(`/api/lists/${theirs.body.id}`)).status, 404);
      assert.equal((await alex.del(`/api/lists/${theirs.body.id}`)).status, 404);
    });
  });

  describe('moving a list between spaces', () => {
    it('changes who can see it', async () => {
      await shareWith(sam);
      const elsewhere = await alex.post<{ id: string }>('/api/spaces', { name: 'Just me' });
      assert.equal(elsewhere.status, 201);

      const moved = await alex.patch(`/api/lists/${list.id}`, { spaceId: elsewhere.body.id });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.spaceId, elsewhere.body.id);

      assert.equal((await sam.get(`/api/lists/${list.id}`)).status, 404);
      assert.equal((await alex.get(`/api/lists/${list.id}`)).status, 200);
    });

    it('is the list owner’s call, not the space owner’s', async () => {
      await shareWith(sam);
      const theirs = await sam.post<{ id: string }>('/api/lists', { name: 'Sam’s', spaceId });
      const samsOwn = await sam.post<{ id: string }>('/api/spaces', { name: 'Sam’s place' });

      // Alex owns the space and has owner rights on the list, but handing it to
      // a different audience is still not Alex's decision.
      const byAlex = await alex.patch(`/api/lists/${theirs.body.id}`, { spaceId: samsOwn.body.id });
      assert.equal(byAlex.status, 403);
      assert.match(byAlex.body.error, /made this list/i);

      assert.equal(
        (await sam.patch(`/api/lists/${theirs.body.id}`, { spaceId: samsOwn.body.id })).status,
        200,
      );
    });

    it('refuses a space you are not in, without saying whether it exists', async () => {
      const theirs = await stranger.post<{ id: string }>('/api/spaces', { name: 'Not yours' });
      const response = await alex.patch(`/api/lists/${list.id}`, { spaceId: theirs.body.id });
      assert.equal(response.status, 404);
    });

    it('refuses a space you are only a viewer of', async () => {
      const samsOwn = await sam.post<{ id: string }>('/api/spaces', { name: 'Sam’s place' });
      const invite = await sam.post<{ token: string }>(`/api/spaces/${samsOwn.body.id}/invites`, {
        role: 'viewer',
      });
      await alex.post(`/api/invites/token/${invite.body.token}/accept`);

      const response = await alex.patch(`/api/lists/${list.id}`, { spaceId: samsOwn.body.id });
      assert.equal(response.status, 403);
    });
  });

  describe('the space itself', () => {
    it('is made on demand by the first list somebody creates', async () => {
      const fresh = await h.signIn('fresh');
      assert.deepEqual((await fresh.get('/api/spaces')).body, [], 'nothing until there is something');

      const first = await createList(fresh, { name: 'Mine' });
      const spaces = await fresh.get<{ id: string; name: string; role: string }[]>('/api/spaces');

      assert.equal(spaces.body.length, 1);
      assert.equal(spaces.body[0]!.id, first.spaceId);
      assert.equal(spaces.body[0]!.role, 'owner');
      assert.equal(spaces.body[0]!.name, 'fresh’s home', 'named after whoever it belongs to');
    });

    it('is reused rather than multiplied by the next list', async () => {
      const second = await createList(alex, { name: 'Garage' });
      assert.equal(second.spaceId, spaceId);
      assert.equal((await alex.get('/api/spaces')).body.length, 1);
    });

    it('can be renamed by its owner and nobody else', async () => {
      await shareWith(sam);
      assert.equal((await sam.patch(`/api/spaces/${spaceId}`, { name: 'Ours' })).status, 403);

      const renamed = await alex.patch(`/api/spaces/${spaceId}`, { name: 'The flat', emoji: '🌴' });
      assert.equal(renamed.status, 200);
      assert.equal(renamed.body.name, 'The flat');
      assert.equal(renamed.body.emoji, '🌴');
    });

    it('will not be deleted while it still holds lists', async () => {
      const response = await alex.del(`/api/spaces/${spaceId}`);
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'space_not_empty');
      assert.equal((await alex.get(`/api/lists/${list.id}`)).status, 200, 'and nothing was lost');

      assert.equal((await alex.del(`/api/lists/${list.id}`)).status, 204);
      assert.equal((await alex.del(`/api/spaces/${spaceId}`)).status, 204);
    });
  });

  describe('leaving a space', () => {
    it('takes the lists you made there with you', async () => {
      await shareWith(sam);
      const theirs = await sam.post<{ id: string }>('/api/lists', { name: 'Sam’s', spaceId });

      assert.equal((await sam.del(`/api/spaces/${spaceId}/members/${sam.id}`)).status, 204);

      // Gone from Alex's space, still Sam's — rather than stranded in a space
      // its owner can no longer reach.
      assert.equal((await alex.get(`/api/lists/${theirs.body.id}`)).status, 404);
      const kept = await sam.get(`/api/lists/${theirs.body.id}`);
      assert.equal(kept.status, 200);
      assert.notEqual(kept.body.spaceId, spaceId);
      assert.equal((await sam.get(`/api/lists/${list.id}`)).status, 404, 'and Alex’s stay Alex’s');
    });

    it('is the same when the owner removes somebody', async () => {
      await shareWith(sam);
      const theirs = await sam.post<{ id: string }>('/api/lists', { name: 'Sam’s', spaceId });

      assert.equal((await alex.del(`/api/spaces/${spaceId}/members/${sam.id}`)).status, 204);

      assert.equal((await alex.get(`/api/lists/${theirs.body.id}`)).status, 404);
      assert.equal((await sam.get(`/api/lists/${theirs.body.id}`)).status, 200);
    });
  });
});
