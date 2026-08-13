import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  SKIP_REASON,
  createList,
  startHarness,
  type Harness,
  type SeededList,
  type TestUser,
} from './helpers/harness.ts';

/**
 * Invite links let anyone holding them join, which is what was asked for. The
 * guardrails — expiry, revoke, use cap — are therefore the only thing between a
 * link pasted into a group chat and a stranger with tick access, so they get
 * tested against a real database rather than a stubbed one.
 */
describe('invites', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let owner: TestUser;
  let guest: TestUser;
  let other: TestUser;
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
    guest = await h.signIn('guest');
    other = await h.signIn('other');
    list = await createList(owner, { name: 'Home' });
  });

  const create = async (body: Record<string, unknown> = { role: 'editor' }) => {
    const response = await owner.post(`/api/lists/${list.id}/invites`, body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };

  const roleOf = async (userId: string) => {
    const { rows } = await h.sql.query<{ role: string }>(
      'SELECT role FROM list_members WHERE list_id = $1 AND user_id = $2',
      [list.id, userId],
    );
    return rows[0]?.role ?? null;
  };

  const useCount = async (id: string) => {
    const { rows } = await h.sql.query<{ use_count: number }>(
      'SELECT use_count FROM invites WHERE id = $1',
      [id],
    );
    return rows[0]?.use_count;
  };

  describe('creating one', () => {
    it('returns an unguessable token and a link built from APP_ORIGIN', async () => {
      const invite = await create({ role: 'viewer' });

      assert.equal(invite.role, 'viewer');
      assert.equal(invite.useCount, 0);
      assert.equal(invite.url, `http://tally.test/j/${invite.token}`);
      assert.ok(invite.token.length >= 20, 'a short code would be brute-forceable');
      assert.match(invite.token, /^[A-Za-z0-9_-]+$/);
    });

    it('expires in seven days by default', async () => {
      const invite = await create();
      const days = (new Date(invite.expiresAt).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 6.9 && days < 7.1, `expected roughly 7 days, got ${days}`);
    });

    it('honours an explicit lifetime, and null for never', async () => {
      assert.ok((await create({ role: 'viewer', expiresInDays: 1 })).expiresAt);
      assert.equal((await create({ role: 'viewer', expiresInDays: null })).expiresAt, null);
    });

    it('refuses a role the invite system has no business handing out', async () => {
      const response = await owner.post(`/api/lists/${list.id}/invites`, { role: 'owner' });
      assert.equal(response.status, 400);
    });

    it('lists the live ones and hides the revoked', async () => {
      const kept = await create({ role: 'viewer' });
      const killed = await create({ role: 'editor' });
      await owner.del(`/api/invites/${killed.id}`);

      const response = await owner.get(`/api/lists/${list.id}/invites`);
      assert.deepEqual(
        response.body.map((invite: { id: string }) => invite.id),
        [kept.id],
      );
    });
  });

  describe('previewing one', () => {
    it('says what the list is without needing a sign-in', async () => {
      const invite = await create({ role: 'viewer' });
      const preview = await h.anonymous().get(`/api/invites/token/${invite.token}`);

      assert.equal(preview.status, 200);
      assert.equal(preview.body.status, 'ok');
      assert.equal(preview.body.role, 'viewer');
      assert.equal(preview.body.inviterName, 'owner');
      assert.equal(preview.body.list.name, 'Home');
      assert.equal(preview.body.list.memberCount, 1);
    });

    it('tells someone already in that they are already in', async () => {
      const invite = await create();
      await guest.post(`/api/invites/token/${invite.token}/accept`);

      const preview = await guest.get(`/api/invites/token/${invite.token}`);
      assert.equal(preview.body.status, 'already_member');
    });

    it('reports an unknown token as not_found rather than 404-ing the page', async () => {
      const preview = await h.anonymous().get('/api/invites/token/nosuchtoken');
      assert.deepEqual(preview.body, { status: 'not_found' });
    });

    it('never leaks the list to a token that has been turned off', async () => {
      const invite = await create();
      await owner.del(`/api/invites/${invite.id}`);

      const preview = await h.anonymous().get(`/api/invites/token/${invite.token}`);
      assert.equal(preview.body.status, 'revoked');
    });
  });

  describe('accepting one', () => {
    it('adds the invitee at the role the link carries', async () => {
      const invite = await create({ role: 'viewer' });
      const response = await guest.post(`/api/invites/token/${invite.token}/accept`);

      assert.equal(response.status, 200);
      assert.equal(response.body.listId, list.id);
      assert.equal(await roleOf(guest.id), 'viewer');
      assert.equal(await useCount(invite.id), 1);
      assert.equal((await guest.get(`/api/lists/${list.id}`)).status, 200);
    });

    it('is a no-op the second time, and does not spend another use', async () => {
      const invite = await create({ role: 'viewer', maxUses: 2 });
      await guest.post(`/api/invites/token/${invite.token}/accept`);
      const again = await guest.post(`/api/invites/token/${invite.token}/accept`);

      assert.equal(again.status, 200);
      assert.equal(await useCount(invite.id), 1, 'accepting twice must not burn a use');
      assert.equal(await roleOf(guest.id), 'viewer');
    });

    it('does not demote or promote an existing member', async () => {
      await h.join(list.id, guest.id, 'editor');
      const invite = await create({ role: 'viewer' });
      await guest.post(`/api/invites/token/${invite.token}/accept`);

      assert.equal(await roleOf(guest.id), 'editor');
    });

    it('is refused once revoked', async () => {
      const invite = await create();
      await owner.del(`/api/invites/${invite.id}`);

      const response = await guest.post(`/api/invites/token/${invite.token}/accept`);
      assert.equal(response.status, 410);
      assert.equal(response.body.code, 'revoked');
      assert.equal(await roleOf(guest.id), null);
    });

    it('is refused once expired', async () => {
      const invite = await create({ role: 'viewer', expiresInDays: 1 });
      await h.sql.query(`UPDATE invites SET expires_at = now() - INTERVAL '1 minute' WHERE id = $1`, [
        invite.id,
      ]);

      const response = await guest.post(`/api/invites/token/${invite.token}/accept`);
      assert.equal(response.status, 410);
      assert.equal(response.body.code, 'expired');
      assert.equal(await roleOf(guest.id), null);
    });

    it('is refused once the use cap is reached', async () => {
      const invite = await create({ role: 'viewer', maxUses: 1 });
      assert.equal((await guest.post(`/api/invites/token/${invite.token}/accept`)).status, 200);

      const second = await other.post(`/api/invites/token/${invite.token}/accept`);
      assert.equal(second.status, 410);
      assert.equal(second.body.code, 'used_up');
      assert.equal(await roleOf(other.id), null);
    });

    it('404s on a token that does not exist', async () => {
      assert.equal((await guest.post('/api/invites/token/nosuchtoken/accept')).status, 404);
    });

    it('needs a signed-in caller', async () => {
      const invite = await create();
      assert.equal((await h.anonymous().post(`/api/invites/token/${invite.token}/accept`)).status, 401);
    });
  });

  describe('two people opening the same single-use link at once', () => {
    it('lets exactly one of them in', async () => {
      const invite = await create({ role: 'viewer', maxUses: 1 });

      // This is what the SELECT ... FOR UPDATE in the accept transaction is for:
      // without it both callers read use_count = 0 and both get in.
      const results = await Promise.all([
        guest.post(`/api/invites/token/${invite.token}/accept`),
        other.post(`/api/invites/token/${invite.token}/accept`),
      ]);

      const statuses = results.map((result) => result.status).sort();
      assert.deepEqual(statuses, [200, 410], JSON.stringify(results.map((r) => r.body)));
      assert.equal(await useCount(invite.id), 1);

      const joined = [await roleOf(guest.id), await roleOf(other.id)].filter(Boolean);
      assert.deepEqual(joined, ['viewer']);

      const members = await owner.get(`/api/lists/${list.id}/members`);
      assert.equal(members.body.length, 2, 'the owner plus exactly one invitee');
    });

    it('holds under a wider stampede', async () => {
      const invite = await create({ role: 'viewer', maxUses: 2 });
      const crowd = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((uid) => h.signIn(uid)),
      );

      const results = await Promise.all(
        crowd.map((person) => person.post(`/api/invites/token/${invite.token}/accept`)),
      );

      assert.equal(results.filter((result) => result.status === 200).length, 2);
      assert.equal(results.filter((result) => result.status === 410).length, 3);
      assert.equal(await useCount(invite.id), 2);
    });
  });

  describe('revoking', () => {
    it('is idempotent and keeps the original revocation time', async () => {
      const invite = await create();
      assert.equal((await owner.del(`/api/invites/${invite.id}`)).status, 204);

      const { rows: first } = await h.sql.query('SELECT revoked_at FROM invites WHERE id = $1', [
        invite.id,
      ]);
      assert.equal((await owner.del(`/api/invites/${invite.id}`)).status, 204);
      const { rows: second } = await h.sql.query('SELECT revoked_at FROM invites WHERE id = $1', [
        invite.id,
      ]);

      assert.deepEqual(second[0].revoked_at, first[0].revoked_at);
    });

    it('404s for an invite that is not there', async () => {
      const response = await owner.del('/api/invites/2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11');
      assert.equal(response.status, 404);
    });
  });
});
