import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile, utimes } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { SKIP_REASON } from './helpers/harness.ts';

/**
 * `npm run dev -w @tally/server`, started for real (#33).
 *
 * The unit tests next door prove the module graph resolves; this one proves the
 * rest of the promise — that the dev command boots, applies migrations, serves
 * `GET /api/health`, and comes back by itself when a file under `src/` changes.
 * Only a real process against a real Postgres can show that, so it skips
 * without DATABASE_URL rather than pretending.
 *
 * This one drives the command from outside rather than using `startHarness`:
 * the thing under test is the process `npm run dev` starts, not the app object.
 */

const SERVER_ROOT = new URL('../', import.meta.url);
const rawDatabaseUrl = process.env.DATABASE_URL ?? '';

/** A port nothing is listening on, borrowed and immediately given back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function scopedTo(schema: string): string {
  const url = new URL(rawDatabaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

describe('npm run dev -w @tally/server', { skip: SKIP_REASON }, () => {
  let child: ChildProcess | undefined;
  let admin: pg.Pool;
  let schema: string;
  let port: number;
  let output = '';

  /** Resolves once `pattern` has appeared in the child's output since `from`. */
  async function waitFor(pattern: RegExp, from: number, what: string): Promise<void> {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (pattern.test(output.slice(from))) return;
      await delay(100);
    }
    throw new Error(`timed out waiting for ${what}. Output so far:\n${output}`);
  }

  before(async () => {
    schema = `tally_dev_${Date.now()}`;
    admin = new pg.Pool({ connectionString: rawDatabaseUrl, max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    port = await freePort();

    const pkg = JSON.parse(await readFile(new URL('package.json', SERVER_ROOT), 'utf8'));
    const argv: string[] = pkg.scripts.dev.trim().split(/\s+/);

    child = spawn(process.execPath, argv.slice(1), {
      cwd: SERVER_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: scopedTo(schema),
        PORT: String(port),
        TALLY_DEV_AUTH: '1',
        NODE_ENV: 'development',
        WEB_ROOT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group. `--watch` is a supervisor: the server itself is
      // a grandchild, and killing only the supervisor would leave that
      // grandchild holding the port and this runner's pipes open.
      detached: true,
    });
    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));
  });

  after(async () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('boots and serves GET /api/health', async () => {
    await waitFor(/listening on :/, 0, 'the server to announce its port');

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200, output);
  });

  it('applied the migrations on the way up', async () => {
    const { rows } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    const tables = rows.map((row) => row.table_name);
    for (const table of ['lists', 'tasks', 'task_completions', 'schema_migrations']) {
      assert.ok(tables.includes(table), `dev boot should have created ${table}, got ${tables}`);
    }
  });

  it('restarts by itself when a file under src/ changes', async () => {
    // Touching mtime rather than rewriting the file: the watcher reacts to it
    // just the same, and other test files are loading these same sources in
    // parallel processes — none of them should be able to read a half-written
    // one because of this test.
    const mark = output.length;
    const now = new Date();
    await utimes(new URL('src/app.ts', SERVER_ROOT), now, now);

    await waitFor(/listening on :/, mark, 'the server to come back after a save');

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200, output);
  });
});
