import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  PgListener,
  backoffDelay,
  type ListenerConnection,
  type ListenerState,
} from '../src/pg-listener.ts';

/**
 * A stand-in for the dedicated `pg.Client`. Real Postgres is exercised in
 * `events.integration.test.ts`; what matters here is the lifecycle around the
 * connection — that a drop is noticed, that it comes back, and that it never
 * quietly gives up — which is precisely the part a live database makes hard to
 * provoke on demand.
 */
class FakeConnection extends EventEmitter implements ListenerConnection {
  readonly queries: string[] = [];
  ended = false;
  connectError: Error | null = null;

  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }

  async query(text: string): Promise<void> {
    this.queries.push(text);
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  /** What Postgres delivers to a client holding a LISTEN. */
  notify(channel: string, payload: string): void {
    this.emit('notification', { channel, payload, processId: 1 });
  }

  /** A connection going away underneath us — a restart, a proxy, a timeout. */
  drop(error = new Error('connection terminated unexpectedly')): void {
    this.emit('error', error);
  }
}

interface Harness {
  listener: PgListener;
  connections: FakeConnection[];
  payloads: string[];
  states: ListenerState[];
  logs: string[];
}

function build(overrides: { connectFailures?: number } = {}): Harness {
  const connections: FakeConnection[] = [];
  const payloads: string[] = [];
  const states: ListenerState[] = [];
  const logs: string[] = [];
  let remainingFailures = overrides.connectFailures ?? 0;

  const listener = new PgListener({
    channel: 'tally_events',
    connect: () => {
      const connection = new FakeConnection();
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        connection.connectError = new Error('ECONNREFUSED');
      }
      connections.push(connection);
      return connection;
    },
    onPayload: (payload) => payloads.push(payload),
    onStateChange: (state) => states.push(state),
    log: (message) => logs.push(message),
    // Real timers, but short enough that the reconnect happens within a tick or
    // two. The shape of the backoff curve is asserted separately, against the
    // pure function, so nothing here has to wait seconds to prove a point.
    backoffMs: [1],
    random: () => 0,
  });

  return { listener, connections, payloads, states, logs };
}

/** Waits for `check` to hold, so a test never races a reconnect timer. */
async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('the LISTEN connection', () => {
  it('subscribes to its channel on start', async () => {
    const h = build();
    await h.listener.start();

    assert.equal(h.connections.length, 1);
    assert.deepEqual(h.connections[0]!.queries, ['LISTEN "tally_events"']);
    assert.equal(h.listener.state, 'listening');

    await h.listener.stop();
  });

  it('hands notifications on its channel to the callback', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.notify('tally_events', '{"hello":1}');
    assert.deepEqual(h.payloads, ['{"hello":1}']);

    await h.listener.stop();
  });

  it('ignores traffic on other channels sharing the database', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.notify('some_other_app', '{"not":"ours"}');
    assert.deepEqual(h.payloads, []);

    await h.listener.stop();
  });

  /* ── The point of the exercise ─────────────────────────────────────────── */

  it('reconnects and re-LISTENs after the connection drops', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.drop();
    assert.equal(h.listener.state, 'reconnecting');

    await until(() => h.listener.state === 'listening', 'the listener to come back');

    assert.equal(h.connections.length, 2);
    // Re-issued, not assumed: a LISTEN does not survive its connection.
    assert.deepEqual(h.connections[1]!.queries, ['LISTEN "tally_events"']);
  });

  it('delivers events again once it is back', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.drop();
    await until(() => h.listener.state === 'listening', 'the listener to come back');

    h.connections[1]!.notify('tally_events', '{"after":"reconnect"}');
    assert.deepEqual(h.payloads, ['{"after":"reconnect"}']);

    await h.listener.stop();
  });

  it('says so loudly rather than going quietly deaf', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.drop();
    await until(() => h.listener.state === 'listening', 'the listener to come back');

    assert.ok(
      h.logs.some((line) => /lost/i.test(line)),
      `expected a log about the lost connection, got ${JSON.stringify(h.logs)}`,
    );

    await h.listener.stop();
  });

  it('treats the connection ending cleanly as a drop too', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.emit('end');
    await until(() => h.connections.length === 2, 'a replacement connection');

    await h.listener.stop();
  });

  /**
   * A dying `pg.Client` emits more than once — the socket error, then the end.
   * Two hazards in one: reconnecting twice, and the second `error` landing on an
   * emitter with no listener, which in Node takes the process down with it.
   */
  it('survives a dying connection emitting more than once', async () => {
    const h = build();
    await h.listener.start();

    const first = h.connections[0]!;
    first.drop();
    first.emit('end');
    first.drop(new Error('and again, after we let go'));

    await until(() => h.listener.state === 'listening', 'the listener to come back');
    // One replacement, not three.
    assert.equal(h.connections.length, 2);

    await h.listener.stop();
  });

  it('leaves a stopped connection safe to emit into', async () => {
    const h = build();
    await h.listener.start();
    const connection = h.connections[0]!;

    await h.listener.stop();
    // Would throw if `stop` had left the emitter without an error listener.
    connection.drop();
  });

  it('keeps retrying when the database is not there yet', async () => {
    const h = build({ connectFailures: 3 });

    // Boot does not fail: the server should still serve HTTP while it retries.
    await h.listener.start();
    assert.notEqual(h.listener.state, 'listening');

    await until(() => h.listener.state === 'listening', 'the listener to give up on failing');
    assert.equal(h.connections.length, 4);

    await h.listener.stop();
  });

  it('throws away the failed connection instead of leaking it', async () => {
    const h = build();
    await h.listener.start();

    h.connections[0]!.drop();
    await until(() => h.listener.state === 'listening', 'the listener to come back');

    assert.equal(h.connections[0]!.ended, true);
    assert.equal(h.connections[0]!.listenerCount('notification'), 0);

    await h.listener.stop();
  });

  it('stops for good when told to, mid-reconnect', async () => {
    const h = build({ connectFailures: 50 });
    await h.listener.start();

    await h.listener.stop();
    const seen = h.connections.length;

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.connections.length, seen, 'a stopped listener kept reconnecting');
    assert.equal(h.listener.state, 'stopped');
  });

  it('does not deliver anything after being stopped', async () => {
    const h = build();
    await h.listener.start();
    const connection = h.connections[0]!;

    await h.listener.stop();
    connection.notify('tally_events', '{"too":"late"}');

    assert.deepEqual(h.payloads, []);
  });

  it('resets the backoff after a successful reconnect', async () => {
    const h = build({ connectFailures: 2 });
    await h.listener.start();
    await until(() => h.listener.state === 'listening', 'the first connection');

    assert.equal(h.listener.failures, 0);

    h.connections.at(-1)!.drop();
    assert.equal(h.listener.failures, 1);

    await until(() => h.listener.state === 'listening', 'the reconnect');
    assert.equal(h.listener.failures, 0);

    await h.listener.stop();
  });
});

/**
 * The curve itself, as a pure function — so the retry behaviour is pinned
 * without any test having to sit through it.
 */
describe('reconnect backoff', () => {
  const schedule = [250, 500, 1000, 5000, 30_000];

  it('climbs and then holds at the ceiling', () => {
    const noJitter = () => 0;
    assert.equal(backoffDelay(0, schedule, noJitter), 250);
    assert.equal(backoffDelay(1, schedule, noJitter), 500);
    assert.equal(backoffDelay(4, schedule, noJitter), 30_000);
    assert.equal(backoffDelay(99, schedule, noJitter), 30_000);
  });

  /** Otherwise every instance in a deploy reconnects in lockstep. */
  it('spreads reconnects out with jitter', () => {
    // Full jitter is 25% on top, and never more.
    assert.equal(backoffDelay(0, schedule, () => 1), Math.round(250 * 1.25));
    assert.ok(backoffDelay(0, schedule, () => 0.5) > backoffDelay(0, schedule, () => 0));
    assert.ok(backoffDelay(4, schedule, () => 1) <= 30_000 * 1.25);
  });

  it('never returns something a timer would treat as immediate', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.ok(backoffDelay(attempt, schedule, Math.random) >= 1);
    }
  });
});
