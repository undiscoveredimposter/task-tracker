/**
 * A single Postgres connection that does nothing but hold a `LISTEN`.
 *
 * It is deliberately not a pooled connection. A pooled client is handed back
 * after every query and may be handed to somebody else, or closed when the pool
 * trims idle connections — and a `LISTEN` lives on the connection, so it would
 * disappear without anything looking wrong. This one is owned outright, for the
 * life of the process.
 *
 * The connection *will* drop: a database restart, a deploy, an idle timeout in
 * whatever sits between us and Postgres. When it does, the instance is deaf —
 * ticks made elsewhere stop arriving and nothing errors, which is the worst way
 * for realtime to fail. So a drop is logged loudly and retried forever with
 * backoff, and the state is readable from outside for the healthcheck.
 *
 * The connection is injected rather than constructed here, which is what lets
 * the reconnect path be tested without a database that can be knocked over on
 * demand.
 */

export type ListenerState = 'stopped' | 'connecting' | 'listening' | 'reconnecting';

/** The part of `pg.Client` this needs. Narrow on purpose, so a fake is cheap. */
export interface ListenerConnection {
  // `unknown` rather than `void` because `pg.Client.connect()` resolves to
  // itself. Nothing here uses the result either way.
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', handler: (message: { channel: string; payload?: string }) => void): this;
  on(event: 'error', handler: (error: Error) => void): this;
  on(event: 'end', handler: () => void): this;
  removeAllListeners(): this;
}

export interface PgListenerOptions {
  /** Already validated as a bare identifier — see `isValidChannelName`. */
  channel: string;
  connect: () => ListenerConnection;
  onPayload: (payload: string) => void;
  onStateChange?: (state: ListenerState) => void;
  log?: (message: string, error?: unknown) => void;
  /** Delay per consecutive failure, holding at the last entry. */
  backoffMs?: number[];
  random?: () => number;
}

export const DEFAULT_BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Delay before retry number `failures`, with up to 25% added on top. The jitter
 * matters when a database restart drops every instance at once: without it they
 * all come back at the same millisecond, which is how a recovering database
 * gets knocked over a second time.
 */
export function backoffDelay(
  failures: number,
  schedule: number[] = DEFAULT_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const base = schedule[Math.min(failures, schedule.length - 1)] ?? 1_000;
  return Math.max(1, Math.round(base + base * 0.25 * random()));
}

export class PgListener {
  #state: ListenerState = 'stopped';
  #failures = 0;
  #connection: ListenerConnection | null = null;
  #retry: NodeJS.Timeout | null = null;
  #running = false;
  /** Guards against `error` and `end` both firing for one dead connection. */
  #generation = 0;
  // Written out rather than a parameter property: Node's type stripping, which
  // is how the tests run `src/` directly, does not support those.
  readonly #options: PgListenerOptions;

  constructor(options: PgListenerOptions) {
    this.#options = options;
  }

  get state(): ListenerState {
    return this.#state;
  }

  /** Consecutive failed attempts. Zero whenever the listener is healthy. */
  get failures(): number {
    return this.#failures;
  }

  get healthy(): boolean {
    return this.#state === 'listening';
  }

  /**
   * Resolves once the first attempt has settled — connected, or failed and
   * scheduled to retry. It deliberately does not reject: an instance that can
   * serve HTTP should serve it, noisily degraded, rather than refuse to boot
   * because the database was slow to come back.
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#attempt();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#generation += 1;
    this.#setState('stopped');

    const connection = this.#connection;
    this.#connection = null;
    if (connection) await this.#discard(connection);
  }

  #setState(state: ListenerState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#options.onStateChange?.(state);
  }

  #log(message: string, error?: unknown): void {
    (this.#options.log ?? ((line, err) => console.error(`[tally] ${line}`, err ?? '')))(
      message,
      error,
    );
  }

  async #attempt(): Promise<void> {
    if (!this.#running) return;
    this.#setState(this.#failures === 0 ? 'connecting' : 'reconnecting');

    const generation = this.#generation;
    const connection = this.#options.connect();

    try {
      await connection.connect();
      // Re-issued every time: a LISTEN belongs to a connection, and the one it
      // belonged to is gone.
      await connection.query(`LISTEN "${this.#options.channel}"`);
    } catch (error) {
      await this.#discard(connection);
      this.#scheduleRetry(error);
      return;
    }

    // Stopped, or superseded, while the connection was being made.
    if (!this.#running || generation !== this.#generation) {
      await this.#discard(connection);
      return;
    }

    connection.on('notification', (message) => {
      if (!this.#running) return;
      if (message.channel !== this.#options.channel) return;
      if (message.payload === undefined) return;
      this.#options.onPayload(message.payload);
    });
    connection.on('error', (error) => this.#lost(generation, error));
    connection.on('end', () => this.#lost(generation));

    this.#connection = connection;
    if (this.#failures > 0) this.#log(`live updates: listener reconnected on attempt ${this.#failures + 1}`);
    this.#failures = 0;
    this.#setState('listening');
  }

  #lost(generation: number, error?: unknown): void {
    if (!this.#running || generation !== this.#generation) return;
    this.#generation += 1;

    const connection = this.#connection;
    this.#connection = null;
    if (connection) void this.#discard(connection);

    this.#scheduleRetry(error, 'lost');
  }

  #scheduleRetry(error: unknown, reason: 'lost' | 'failed' = 'failed'): void {
    if (!this.#running) return;

    this.#failures += 1;
    this.#setState('reconnecting');

    const delay = backoffDelay(this.#failures - 1, this.#options.backoffMs, this.#options.random);
    this.#log(
      reason === 'lost'
        ? `live updates: LISTEN connection lost — this instance is deaf to other instances, retrying in ${delay}ms`
        : `live updates: could not open the LISTEN connection (attempt ${this.#failures}), retrying in ${delay}ms`,
      error,
    );

    this.#retry = setTimeout(() => void this.#attempt(), delay);
    this.#retry.unref();
  }

  async #discard(connection: ListenerConnection): Promise<void> {
    connection.removeAllListeners();
    // A dead `pg.Client` can emit `error` more than once — the socket error and
    // the subsequent end are separate events. An EventEmitter with no `error`
    // listener throws, so dropping our handlers without leaving a sink behind
    // would turn a routine reconnect into a crashed container.
    connection.on('error', () => {});
    try {
      await connection.end();
    } catch {
      // Already dead in every case that gets us here.
    }
  }
}
