import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import type { ServerEvent } from '@tally/shared';
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
 * Your own profile: renaming yourself, and leaving for good.
 *
 * The rename has one trap worth a whole suite. `requireAuth` reflects the
 * Firebase identity into `users` on *every* request, so without a flag marking a
 * name as the person's own, a name set here lives exactly until their next
 * request. "survives the next authenticated request" below is the test that
 * matters most in this file.
 *
 * The delete is mostly a story about foreign keys — owned lists cascade,
 * authorship goes null — which is SQL behaviour, so it is asserted against a
 * real Postgres rather than a mock.
 */

/** Listens on the app's NOTIFY channel, the way a second container would. */
class ChannelSpy {
  readonly events: ServerEvent[] = [];
  // Written out rather than as a constructor parameter property: those are the
  // one piece of TypeScript Node's type stripping cannot erase.
  readonly channel: string;
  #client: pg.Client;

  constructor(channel: string) {
    this.channel = channel;
    this.#client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  }

  async open(): Promise<void> {
    await this.#client.connect();
    this.#client.on('notification', (message) => {
      if (message.channel !== this.channel || !message.payload) return;
      try {
        const envelope = JSON.parse(message.payload) as { event?: ServerEvent };
        if (envelope.event) this.events.push(envelope.event);
      } catch {
        // Not ours to interpret; the wire format has its own tests.
      }
    });
    await this.#client.query(`LISTEN "${this.channel}"`);
  }

  async waitFor(match: (event: ServerEvent) => boolean, what: string): Promise<ServerEvent> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(this.events)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  clear(): void {
    this.events.length = 0;
  }

  async close(): Promise<void> {
    await this.#client.end();
  }
}

describe('your own profile', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let alex: TestUser;
  let sam: TestUser;

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
  });

  /* ── GET ───────────────────────────────────────────────────────────────── */

  describe('GET /api/me', () => {
    it('hands back the profile the rest of the API knows about', async () => {
      const response = await alex.get('/api/me');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        id: alex.id,
        displayName: 'alex',
        email: 'alex@example.test',
        photoUrl: null,
      });
    });

    it('needs a token', async () => {
      assert.equal((await h.anonymous().get('/api/me')).status, 401);
    });
  });

  /* ── Renaming yourself ─────────────────────────────────────────────────── */

  describe('PATCH /api/me', () => {
    it('renames you and answers with the same shape GET does', async () => {
      const response = await alex.patch('/api/me', { displayName: 'Alex Rivera' });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        id: alex.id,
        displayName: 'Alex Rivera',
        email: 'alex@example.test',
        photoUrl: null,
      });
    });

    it('survives the next authenticated request', async () => {
      // The whole point of display_name_custom. requireAuth upserts the provider
      // identity on every single request; without the guard this reads back as
      // 'alex' and the feature silently does nothing.
      await alex.patch('/api/me', { displayName: 'Alex Rivera' });

      const again = await alex.get<{ displayName: string }>('/api/me');
      assert.equal(again.body.displayName, 'Alex Rivera');

      // And still after a handful more — one request is not a fluke, a session is.
      await alex.get('/api/lists');
      await alex.get('/api/lists');
      const later = await alex.get<{ displayName: string }>('/api/me');
      assert.equal(later.body.displayName, 'Alex Rivera');
    });

    it('is what the other members of a list then see', async () => {
      const list = await createList(alex);
      await h.join(list.id, sam.id, 'editor');

      await sam.patch('/api/me', { displayName: 'Sam O.' });

      const members = await alex.get<{ id: string; displayName: string }[]>(
        `/api/lists/${list.id}/members`,
      );
      const entry = members.body.find((member) => member.id === sam.id);
      assert.equal(entry?.displayName, 'Sam O.');
    });

    it('does not change anything else about you', async () => {
      await alex.patch('/api/me', { displayName: 'Alex Rivera' });
      const { rows } = await h.sql.query<{ email: string; firebase_uid: string }>(
        'SELECT email, firebase_uid FROM users WHERE id = $1',
        [alex.id],
      );
      assert.equal(rows[0]?.email, 'alex@example.test');
      assert.equal(rows[0]?.firebase_uid, 'alex');
    });

    it('trims the name before storing it', async () => {
      const response = await alex.patch<{ displayName: string }>('/api/me', {
        displayName: '   Alex Rivera   ',
      });
      assert.equal(response.body.displayName, 'Alex Rivera');
    });

    it('refuses a name that is empty once trimmed, in words a person can read', async () => {
      const response = await alex.patch<{ error: string }>('/api/me', { displayName: '   ' });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /name/i);
      assert.doesNotMatch(response.body.error, /expected|ZodError|string_too_small/i);
    });

    it('refuses a name longer than the cap', async () => {
      const response = await alex.patch<{ error: string }>('/api/me', {
        displayName: 'a'.repeat(33),
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /32/);
    });

    it('refuses a name that is not a string, and a body with no name at all', async () => {
      assert.equal((await alex.patch('/api/me', { displayName: 42 })).status, 400);
      assert.equal((await alex.patch('/api/me', {})).status, 400);
    });

    it('leaves the stored name alone when the request is refused', async () => {
      await alex.patch('/api/me', { displayName: 'Alex Rivera' });
      await alex.patch('/api/me', { displayName: '' });
      const again = await alex.get<{ displayName: string }>('/api/me');
      assert.equal(again.body.displayName, 'Alex Rivera');
    });

    it('cannot be used to rename somebody else, whatever the body says', async () => {
      const before = await sam.get<{ displayName: string }>('/api/me');
      await alex.patch('/api/me', { displayName: 'Alex Rivera', id: sam.id });

      const after = await sam.get<{ displayName: string }>('/api/me');
      assert.equal(after.body.displayName, before.body.displayName);
    });

    it('needs a token', async () => {
      const response = await h.anonymous().patch('/api/me', { displayName: 'Nobody' });
      assert.equal(response.status, 401);
    });

    it('tells the lists you are on that the members list changed', async () => {
      const spy = new ChannelSpy(h.eventChannel);
      await spy.open();
      try {
        const list = await createList(alex);
        await h.join(list.id, sam.id, 'editor');
        spy.clear();

        await sam.patch('/api/me', { displayName: 'Sam O.' });

        const event = await spy.waitFor(
          (candidate) => candidate.type === 'members.changed' && candidate.listId === list.id,
          'members.changed after a rename',
        );
        assert.equal(event.type, 'members.changed');
      } finally {
        await spy.close();
      }
    });
  });

  /* ── Leaving for good ──────────────────────────────────────────────────── */

  describe('DELETE /api/me', () => {
    it('deletes your row and says nothing about it', async () => {
      const response = await alex.del('/api/me');
      assert.equal(response.status, 204);
      assert.equal(response.body, null);

      const { rows } = await h.sql.query('SELECT id FROM users WHERE id = $1', [alex.id]);
      assert.equal(rows.length, 0);
    });

    it('takes the lists you own with it, for everyone who was on them', async () => {
      const list = await createList(alex);
      await h.join(list.id, sam.id, 'editor');

      assert.equal((await alex.del('/api/me')).status, 204);

      // 404 rather than 403: whether a list exists is private, and this one no
      // longer does for anybody.
      assert.equal((await sam.get(`/api/lists/${list.id}`)).status, 404);
      const { rows } = await h.sql.query('SELECT id FROM lists WHERE id = $1', [list.id]);
      assert.equal(rows.length, 0);
    });

    it('leaves a list you were only a member of standing, minus you', async () => {
      const list = await createList(sam);
      await h.join(list.id, alex.id, 'editor');

      await alex.del('/api/me');

      const detail = await sam.get<{ members: { id: string }[] }>(`/api/lists/${list.id}`);
      assert.equal(detail.status, 200);
      assert.deepEqual(
        detail.body.members.map((member) => member.id),
        [sam.id],
      );
    });

    it('keeps the ticks you left behind, because the stats are made of them', async () => {
      const list = await createList(sam);
      await h.join(list.id, alex.id, 'editor');
      const task = await createTask(sam, list.id);
      assert.equal((await alex.post(`/api/tasks/${task.id}/complete`)).status, 200);

      await alex.del('/api/me');

      // The row survives with no author — a hard delete here would rewrite
      // history and quietly change everyone's stats.
      const { rows } = await h.sql.query<{ completed_by: string | null }>(
        'SELECT completed_by FROM task_completions WHERE task_id = $1',
        [task.id],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.completed_by, null);

      const detail = await sam.get<{ tasks: { completion: unknown }[] }>(`/api/lists/${list.id}`);
      assert.equal(detail.status, 200);
    });

    it('tells the other members of your lists that they changed', async () => {
      const spy = new ChannelSpy(h.eventChannel);
      await spy.open();
      try {
        const owned = await createList(alex, { name: 'Alex owns this' });
        const joined = await createList(sam, { name: 'Sam owns this' });
        await h.join(owned.id, sam.id, 'editor');
        await h.join(joined.id, alex.id, 'editor');
        spy.clear();

        await alex.del('/api/me');

        await spy.waitFor(
          (event) => event.type === 'list.deleted' && event.listId === owned.id,
          'list.deleted for the list they owned',
        );
        await spy.waitFor(
          (event) => event.type === 'members.changed' && event.listId === joined.id,
          'members.changed for the list they had merely joined',
        );
      } finally {
        await spy.close();
      }
    });

    it('makes a fresh profile if the same person signs in again', async () => {
      await alex.patch('/api/me', { displayName: 'Alex Rivera' });
      const originalId = alex.id;
      await alex.del('/api/me');

      const returning = await h.signIn('alex');
      assert.notEqual(returning.id, originalId);

      const me = await returning.get<{ displayName: string }>('/api/me');
      // A new row, following the provider again — the old custom name is gone
      // along with the profile that chose it.
      assert.equal(me.body.displayName, 'alex');
    });

    it('needs a token', async () => {
      assert.equal((await h.anonymous().del('/api/me')).status, 401);
    });
  });
});
