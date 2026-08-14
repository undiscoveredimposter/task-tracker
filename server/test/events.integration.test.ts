import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ServerEvent } from '@tally/shared';
import pg from 'pg';
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
 * Live updates across two app instances.
 *
 * The harness is one instance: an HTTP server, its own subscriber set, its own
 * `LISTEN` connection. The second instance is stood up here as the thing that
 * actually distinguishes the two designs — a separate connection publishing on
 * the same channel, exactly as a second container would. If the fan-out is
 * still in-memory, nothing raised there reaches a phone connected to the
 * harness, and every test below fails.
 */

/** Reads an SSE stream the way the web client does, and remembers what arrived. */
class StreamClient {
  readonly events: ServerEvent[] = [];
  #controller = new AbortController();
  #done: Promise<void> = Promise.resolve();

  async open(baseUrl: string, token: string): Promise<void> {
    const response = await fetch(`${baseUrl}/api/stream`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: this.#controller.signal,
    });
    assert.equal(response.status, 200);

    const body = response.body;
    assert.ok(body, 'the stream had no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    this.#done = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });

          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            for (const line of block.split('\n')) {
              if (line.startsWith('data: ')) {
                this.events.push(JSON.parse(line.slice('data: '.length)) as ServerEvent);
              }
            }
            split = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // Aborted at the end of the test.
      }
    })();

    // The server opens with `hello`, which is also how we know it has been
    // registered as a subscriber — otherwise a NOTIFY could land first.
    await this.waitFor((event) => event.type === 'hello', 'the stream to open');
  }

  async waitFor(
    match: (event: ServerEvent) => boolean,
    what: string,
    timeoutMs = 5000,
  ): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(this.events)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Gives anything in flight a chance to arrive, for the negative assertions. */
  async settle(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await this.#done;
  }
}

describe('live updates across instances', { skip: SKIP_REASON }, () => {
  let h: Harness;
  /** Stands in for a second container: same database, same channel, own id. */
  let other: pg.Client;
  const otherInstanceId = randomUUID();

  let alex: TestUser;
  let sam: TestUser;
  let stranger: TestUser;
  let list: SeededList;
  let taskId: string;

  const openStreams: StreamClient[] = [];

  /** Publishes as the other instance would, with its own `origin`. */
  async function publishFromOther(event: ServerEvent, options: { except?: string } = {}) {
    const listId = 'listId' in event ? event.listId : list.id;
    const payload = JSON.stringify({
      v: 1,
      origin: otherInstanceId,
      listId,
      event,
      except: options.except ?? null,
    });
    await other.query('SELECT pg_notify($1, $2)', [h.eventChannel, payload]);
  }

  async function streamFor(user: TestUser): Promise<StreamClient> {
    const client = new StreamClient();
    await client.open(h.baseUrl, `dev:${user.uid}:${user.email}`);
    openStreams.push(client);
    return client;
  }

  before(async () => {
    h = await startHarness();
    other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
  });

  after(async () => {
    for (const stream of openStreams) await stream.close();
    await other.end();
    await h.close();
  });

  beforeEach(async () => {
    for (const stream of openStreams.splice(0)) await stream.close();
    await h.truncate();

    alex = await h.signIn('alex');
    sam = await h.signIn('sam');
    stranger = await h.signIn('stranger');
    list = await createList(alex, { name: 'Home', timezone: 'UTC' });
    await h.join(list.id, sam.id, 'editor');
    taskId = (await createTask(alex, list.id)).id;
  });

  /* ── The thing the issue is about ──────────────────────────────────────── */

  it('delivers an event raised on another instance', async () => {
    const stream = await streamFor(sam);

    await publishFromOther({ type: 'task.changed', listId: list.id });

    const event = await stream.waitFor(
      (candidate) => candidate.type === 'task.changed',
      'the other instance’s event',
    );
    assert.deepEqual(event, { type: 'task.changed', listId: list.id });
  });

  it('carries a completion through, body and all', async () => {
    const stream = await streamFor(sam);

    const completed: ServerEvent = {
      type: 'task.completed',
      listId: list.id,
      taskId,
      periodKey: 'd:2026-08-13',
      completion: {
        at: '2026-08-13T08:12:00.000Z',
        by: { id: alex.id, displayName: 'Alex', email: alex.email, photoUrl: null },
      },
    };
    await publishFromOther(completed);

    assert.deepEqual(
      await stream.waitFor((event) => event.type === 'task.completed', 'the completion'),
      completed,
    );
  });

  it('reaches every device on this instance, not just the first', async () => {
    const first = await streamFor(sam);
    const second = await streamFor(sam);

    await publishFromOther({ type: 'list.changed', listId: list.id });

    await first.waitFor((event) => event.type === 'list.changed', 'the first device');
    await second.waitFor((event) => event.type === 'list.changed', 'the second device');
  });

  /* ── Who is allowed to hear it ─────────────────────────────────────────── */

  /**
   * Membership is resolved by the instance that delivers, from its own database
   * read — the payload never carries an audience. So this is the same check the
   * API makes, not a second copy of it that could drift.
   */
  it('does not deliver a list’s events to someone who is not a member', async () => {
    const outsider = await streamFor(stranger);
    const member = await streamFor(sam);

    await publishFromOther({ type: 'task.changed', listId: list.id });

    await member.waitFor((event) => event.type === 'task.changed', 'the member to get it');
    await outsider.settle();
    assert.deepEqual(
      outsider.events.filter((event) => event.type !== 'hello'),
      [],
      'a non-member was sent another list’s events',
    );
  });

  it('honours `except` from the other instance', async () => {
    const skipped = await streamFor(sam);
    const other_ = await streamFor(alex);

    await publishFromOther({ type: 'task.changed', listId: list.id }, { except: sam.id });

    await other_.waitFor((event) => event.type === 'task.changed', 'the other member');
    await skipped.settle();
    assert.deepEqual(skipped.events.filter((event) => event.type !== 'hello'), []);
  });

  /* ── What the publishing instance does with its own echo ───────────────── */

  it('publishes what it handles itself, so another instance can pick it up', async () => {
    const heard: string[] = [];
    const eavesdropper = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await eavesdropper.connect();
    await eavesdropper.query(`LISTEN "${h.eventChannel}"`);
    eavesdropper.on('notification', (message) => heard.push(message.payload ?? ''));

    try {
      const response = await alex.post(`/api/tasks/${taskId}/complete`);
      assert.equal(response.status, 200);

      const deadline = Date.now() + 5000;
      while (heard.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(heard.length, 1, 'the tick was not published for other instances');

      const envelope = JSON.parse(heard[0]!);
      assert.equal(envelope.v, 1);
      assert.equal(envelope.listId, list.id);
      assert.equal(envelope.origin, h.instanceId);
      // The ticker's own device already updated optimistically.
      assert.equal(envelope.except, alex.id);
      assert.equal(envelope.event.type, 'task.completed');
      assert.ok(Buffer.byteLength(heard[0]!) < 8000, 'payload over the NOTIFY limit');
    } finally {
      await eavesdropper.end();
    }
  });

  it('does not deliver its own event twice', async () => {
    const stream = await streamFor(sam);

    const response = await alex.post(`/api/tasks/${taskId}/complete`);
    assert.equal(response.status, 200);

    await stream.waitFor((event) => event.type === 'task.completed', 'the tick');
    await stream.settle();

    const ticks = stream.events.filter((event) => event.type === 'task.completed');
    assert.equal(ticks.length, 1, 'the publisher delivered its own NOTIFY echo as well');
  });

  /* ── Payloads from outside ─────────────────────────────────────────────── */

  it('drops a payload it cannot read rather than passing it to a browser', async () => {
    const stream = await streamFor(sam);

    await other.query('SELECT pg_notify($1, $2)', [h.eventChannel, 'not json']);
    await other.query('SELECT pg_notify($1, $2)', [
      h.eventChannel,
      JSON.stringify({ v: 1, origin: otherInstanceId, listId: list.id, except: null, event: { type: 'rm -rf' } }),
    ]);
    // Something valid behind them, so the assertion is about order, not timing.
    await publishFromOther({ type: 'task.changed', listId: list.id });

    await stream.waitFor((event) => event.type === 'task.changed', 'the valid event');
    assert.deepEqual(
      stream.events.filter((event) => event.type !== 'hello' && event.type !== 'task.changed'),
      [],
    );
  });

  /* ── Recovery ──────────────────────────────────────────────────────────── */

  /**
   * The failure this has to survive: Postgres restarts, or something between us
   * and it times the connection out. `pg_terminate_backend` reproduces it
   * exactly — the socket goes away underneath the listener with no warning.
   *
   * The SSE connection the browser holds is untouched by this; it is a
   * connection to *us*, not to Postgres. So a client mid-stream sees nothing at
   * all, except that events raised on other instances stop arriving for as long
   * as the gap lasts. Anything raised on this instance still reaches it.
   */
  it('picks events up again after its LISTEN connection is killed underneath it', async () => {
    const stream = await streamFor(sam);
    const events = await import('../src/events.ts');

    await publishFromOther({ type: 'members.changed', listId: list.id });
    await stream.waitFor((event) => event.type === 'members.changed', 'the first event');

    const killed = await other.query<{ pid: number }>(
      `SELECT pg_terminate_backend(pid) AS ok, pid
         FROM pg_stat_activity
        WHERE query = $1 AND pid <> pg_backend_pid()`,
      [`LISTEN "${h.eventChannel}"`],
    );
    assert.ok(killed.rowCount && killed.rowCount > 0, 'no LISTEN backend found to kill');

    const settle = async (want: (state: string) => boolean, what: string) => {
      const deadline = Date.now() + 15_000;
      while (!want(events.eventListenerState()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(want(events.eventListenerState()), `timed out waiting for ${what}`);
    };

    // The kill reaches us asynchronously, so wait for the listener to notice
    // before waiting for it to recover — otherwise this races its own setup.
    await settle((state) => state !== 'listening', 'the listener to notice the drop');
    // Events raised in between are genuinely lost: NOTIFY has no backlog. That
    // is what the client's refetch-on-reconnect is for, and why these events
    // carry identifiers rather than being the source of truth.
    await settle((state) => state === 'listening', 'the listener to come back');

    await publishFromOther({ type: 'list.changed', listId: list.id });
    await stream.waitFor((event) => event.type === 'list.changed', 'an event after the reconnect');
  });

  it('reports the listener on the healthcheck', async () => {
    const health = await h.anonymous().get<{ ok: boolean; live: string }>('/api/health');

    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.live, 'listening');
  });
});
