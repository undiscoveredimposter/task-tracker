// Must come first: it registers the module-resolution hooks that let the
// dynamic imports below reach `src/*.ts` and `@tally/shared`.
import '../../scripts/ts-resolve.ts';

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';

/**
 * Integration harness: a real Postgres, real migrations, a real HTTP server.
 *
 * Everything below the route handlers — the unique constraint that makes
 * ticking idempotent, the `FOR UPDATE` that serialises invite accepts, the
 * 404-not-403 rule that keeps list existence private — is SQL behaviour, and a
 * mock would only ever confirm what we already believe. So these tests talk to
 * a database.
 *
 * Isolation is per test *file*: each gets a throwaway Postgres schema, reached
 * by pinning `search_path` in the connection string. `node --test` already runs
 * each file in its own process, so the server's module-level pool is per-file
 * too and the two line up. Within a file, `truncate()` between tests keeps
 * ordering from mattering.
 */

const rawDatabaseUrl = process.env.DATABASE_URL ?? '';

/**
 * `undefined` when the suite can run, otherwise the reason it can't — passed
 * straight to `describe(name, { skip })` so a run without a database says so
 * rather than quietly reporting green.
 */
export const SKIP_REASON: string | undefined = rawDatabaseUrl
  ? undefined
  : 'needs a real Postgres and DATABASE_URL is not set. ' +
    'Run `npm run test:db -w @tally/server` (starts a throwaway Postgres with docker compose ' +
    'and runs the whole suite against it), or point DATABASE_URL at your own and re-run.';

export type Role = 'owner' | 'editor' | 'viewer';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface ApiClient {
  get<T = any>(path: string): Promise<ApiResponse<T>>;
  post<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = any>(path: string, body?: unknown): Promise<ApiResponse<T>>;
}

export interface TestUser extends ApiClient {
  /** The `users.id` the API allocated on first contact. */
  id: string;
  uid: string;
  email: string;
}

export interface Harness {
  baseUrl: string;
  /** The app's own pool, scoped to this file's schema — for asserting on rows. */
  sql: pg.Pool;
  schema: string;
  /**
   * The Postgres channel this instance fans live updates out over. Channels are
   * per-database, not per-schema, so each file gets its own — otherwise two
   * suites running side by side would hear each other's events.
   */
  eventChannel: string;
  /** This instance's id, as it appears in the `origin` of what it publishes. */
  instanceId: string;
  /** Applies any migrations this schema hasn't seen. Safe to call repeatedly. */
  migrate(): Promise<void>;
  /** Tables present in this schema, alphabetically. */
  tableNames(): Promise<string[]>;
  /** Migration filenames recorded as applied, or null if the table isn't there. */
  appliedMigrations(): Promise<string[] | null>;
  /** Signs in as `uid`, creating the user row the way a first request would. */
  signIn(uid: string): Promise<TestUser>;
  /** A client with no Authorization header. */
  anonymous(): ApiClient;
  /** A client sending an arbitrary bearer token, for the unhappy auth paths. */
  withToken(token: string): ApiClient;
  /** Adds a membership row directly, for tests about roles rather than invites. */
  join(listId: string, userId: string, role: Role): Promise<void>;
  /** Empties every table but leaves the schema in place. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** Set false to start on an empty schema — the migration tests need that. */
  migrate?: boolean;
  /**
   * Environment applied after the defaults below and before the server modules
   * load. For settings read once at import — rate limits, invite lifetimes.
   */
  env?: Record<string, string>;
}

/** Copy of DATABASE_URL with `search_path` pinned to one throwaway schema. */
function scopedTo(schema: string): string {
  let url: URL;
  try {
    url = new URL(rawDatabaseUrl);
  } catch {
    throw new Error(
      `DATABASE_URL must be a URL for the integration tests to isolate themselves, got: ${rawDatabaseUrl}`,
    );
  }
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Clears up after a run that was killed before it could drop its own schema.
 * The timestamp is in the name because Postgres doesn't record when a schema was
 * created; an hour is far longer than the suite takes, so this can't collide
 * with a run that is still going.
 */
async function reapAbandonedSchemas(admin: pg.Pool): Promise<void> {
  const { rows } = await admin.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'tally\\_test\\_%'`,
  );

  for (const { nspname } of rows) {
    const createdAt = Number(nspname.split('_')[2]);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < ABANDONED_AFTER_MS) continue;
    await admin.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  if (!rawDatabaseUrl) throw new Error(SKIP_REASON);

  const schema = `tally_test_${Date.now()}_${randomBytes(3).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: rawDatabaseUrl, max: 2 });
  await reapAbandonedSchemas(admin);
  await admin.query(`CREATE SCHEMA "${schema}"`);

  // Set before the server modules load: config, and the dev-auth switch in
  // firebase.ts, are both read once at import time.
  process.env.DATABASE_URL = scopedTo(schema);
  process.env.TALLY_DEV_AUTH = '1';
  process.env.NODE_ENV = 'test';
  process.env.APP_ORIGIN = 'http://tally.test';
  // Pinned so a developer's own environment can't change what the tests expect.
  process.env.INVITE_DEFAULT_DAYS = '7';
  // Static serving would otherwise swallow unknown paths behind an SPA fallback.
  process.env.WEB_ROOT = '';
  // Every suite hammers the API from 127.0.0.1, which to a per-address limiter
  // is one extremely busy caller. Raised out of the way here so an unrelated
  // test can never fail with a 429; rate-limit.integration.test.ts sets its own
  // low values through `options.env` and is where the limits are actually tested.
  process.env.RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE = '100000';
  process.env.RATE_LIMIT_WRITES_PER_MINUTE = '100000';
  // A NOTIFY channel is database-wide, so the schema trick that isolates rows
  // does nothing for events. Reuse the schema name, which is already unique per
  // file and is a valid identifier.
  process.env.TALLY_EVENT_CHANNEL = schema;

  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;

  const { pool } = await import('../../src/db.ts');
  const { migrate } = await import('../../src/migrate.ts');
  const { createApp } = await import('../../src/app.ts');
  const events = await import('../../src/events.ts');

  if (options.migrate !== false) await migrate();

  // What index.ts does at boot: this harness is one app instance, listener and
  // all, so a test can stand a second publisher next to it and watch an event
  // cross between them.
  await events.startEventListener();

  const server: Server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = (token: string | null): ApiClient => {
    const send = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';

      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed as T, headers: response.headers };
    };

    return {
      get: (path) => send('GET', path),
      post: (path, body) => send('POST', path, body),
      patch: (path, body) => send('PATCH', path, body),
      del: (path, body) => send('DELETE', path, body),
    };
  };

  const qualified = ['task_completions', 'tasks', 'invites', 'list_members', 'lists', 'users']
    .map((table) => `"${schema}".${table}`)
    .join(', ');

  return {
    baseUrl,
    sql: pool,
    schema,
    eventChannel: process.env.TALLY_EVENT_CHANNEL!,
    instanceId: events.instanceId(),

    migrate,

    async tableNames() {
      const { rows } = await admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name`,
        [schema],
      );
      return rows.map((row) => row.table_name);
    },

    async appliedMigrations() {
      if (!(await this.tableNames()).includes('schema_migrations')) return null;
      const { rows } = await admin.query<{ filename: string }>(
        `SELECT filename FROM "${schema}".schema_migrations ORDER BY filename`,
      );
      return rows.map((row) => row.filename);
    },

    async signIn(uid: string) {
      const email = `${uid}@example.test`;
      const api = client(`dev:${uid}:${email}`);
      const me = await api.get<{ id: string }>('/api/me');
      if (me.status !== 200) {
        throw new Error(`sign-in for ${uid} failed: ${me.status} ${JSON.stringify(me.body)}`);
      }
      return { ...api, id: me.body.id, uid, email };
    },

    anonymous: () => client(null),

    withToken: (token: string) => client(token),

    async join(listId: string, userId: string, role: Role) {
      await pool.query('INSERT INTO list_members (list_id, user_id, role) VALUES ($1, $2, $3)', [
        listId,
        userId,
        role,
      ]);
    },

    async truncate() {
      await admin.query(`TRUNCATE TABLE ${qualified} CASCADE`);
    },

    async close() {
      // Before the pool, and before the schema goes: the listener holds its own
      // connection and a retry timer, and either would keep the process alive.
      await events.stopEventListener();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

/* ── Small seeding helpers, so the tests read as behaviour ───────────────── */

export interface SeededList {
  id: string;
  [key: string]: any;
}

/** Creates a list through the API, so it gets its owner membership row too. */
export async function createList(
  owner: ApiClient,
  body: Record<string, unknown> = {},
): Promise<SeededList> {
  const response = await owner.post<SeededList>('/api/lists', { name: 'Home', ...body });
  if (response.status !== 201) {
    throw new Error(`could not create list: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** Adds a task through the API and returns it. */
export async function createTask(
  editor: ApiClient,
  listId: string,
  title = 'Feed the cat',
): Promise<{ id: string; title: string }> {
  const response = await editor.post<{ tasks: { id: string; title: string }[] }>(
    `/api/lists/${listId}/tasks`,
    { title },
  );
  if (response.status !== 201) {
    throw new Error(`could not create task: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const task = response.body.tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`task ${title} missing from the response`);
  return task;
}
