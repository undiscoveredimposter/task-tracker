import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SKIP_REASON, startHarness, type Harness } from './helpers/harness.ts';

/** Every migration that has shipped, in the order migrate() applies them. */
const MIGRATIONS = [
  '001_init.sql',
  '002_task_positions.sql',
  '003_user_display_name_custom.sql',
];

/**
 * Migrations run on container boot, before the port opens. Two things have to
 * hold or a deploy is a coin toss: they must build the schema from nothing, and
 * running them again — every restart, every replica — must change nothing.
 */
describe('migrations', { skip: SKIP_REASON }, () => {
  let h: Harness;

  before(async () => {
    // Deliberately unmigrated: this suite drives migrate() itself.
    h = await startHarness({ migrate: false });
  });

  after(async () => {
    await h?.close();
  });

  it('starts from a genuinely empty schema', async () => {
    assert.deepEqual(await h.tableNames(), []);
    assert.equal(await h.appliedMigrations(), null);
  });

  it('builds the whole schema from empty', async () => {
    await h.migrate();

    assert.deepEqual(await h.tableNames(), [
      'invites',
      'list_members',
      'lists',
      'schema_migrations',
      'task_completions',
      'tasks',
      'users',
    ]);
    assert.deepEqual(await h.appliedMigrations(), MIGRATIONS);
  });

  it('keeps UNIQUE (task_id, period_key), which is what makes ticking idempotent', async () => {
    const { rows } = await h.sql.query<{ columns: string[] }>(
      // ::text because attname is of type `name`, which the driver hands back
      // unparsed as a raw array literal.
      `SELECT array_agg(a.attname::text ORDER BY a.attname) AS columns
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
        WHERE n.nspname = $1 AND t.relname = 'task_completions' AND c.contype = 'u'
        GROUP BY c.conname`,
      [h.schema],
    );

    assert.deepEqual(
      rows.map((row) => row.columns),
      [['period_key', 'task_id']],
      'the unique constraint the whole reset mechanism rests on has moved or gone',
    );
  });

  it('leaves tasks with a distinct position per list, so reordering has room', async () => {
    // 002 renumbers each list's tasks 1, 2, 3 … The invariant it establishes is
    // what POST /api/tasks/:id/move bisects, so assert the invariant rather than
    // the statement that produced it.
    const { rows } = await h.sql.query<{ duplicates: number }>(
      `SELECT count(*)::int AS duplicates FROM (
         SELECT list_id, position FROM tasks GROUP BY list_id, position HAVING count(*) > 1
       ) AS clashes`,
    );
    assert.equal(rows[0]!.duplicates, 0);

    const indexes = await h.sql.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'tasks'`,
      [h.schema],
    );
    assert.ok(
      indexes.rows.some((row) => row.indexname === 'tasks_list_order_idx'),
      'the index backing the task ordering is missing',
    );
  });

  it('gives every existing user a display_name_custom of false', async () => {
    // 003 adds the flag that stops requireAuth overwriting a name someone chose.
    // It has to default false, or every account that has never opened the
    // settings screen would freeze on whatever the provider last said.
    const { rows } = await h.sql.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'display_name_custom'`,
      [h.schema],
    );
    assert.equal(rows.length, 1, 'display_name_custom is missing from users');
    assert.equal(rows[0]!.is_nullable, 'NO');
    assert.equal(rows[0]!.column_default, 'false');

    await h.sql.query(
      `INSERT INTO users (firebase_uid, email, display_name) VALUES ('backfilled', 'b@c.test', 'Backfilled')`,
    );
    const flags = await h.sql.query<{ display_name_custom: boolean }>(
      `SELECT display_name_custom FROM users WHERE firebase_uid = 'backfilled'`,
    );
    assert.equal(flags.rows[0]!.display_name_custom, false);
    await h.sql.query(`DELETE FROM users WHERE firebase_uid = 'backfilled'`);
  });

  it('applying a second time is a no-op and leaves data alone', async () => {
    const before = await h.sql.query('SELECT * FROM schema_migrations');
    await h.sql.query(
      `INSERT INTO users (firebase_uid, email, display_name) VALUES ('survivor', 'a@b.test', 'Survivor')`,
    );

    await h.migrate();

    const after = await h.sql.query('SELECT * FROM schema_migrations');
    assert.deepEqual(await h.appliedMigrations(), MIGRATIONS);
    assert.equal(after.rowCount, before.rowCount);

    const users = await h.sql.query('SELECT firebase_uid FROM users');
    assert.deepEqual(
      users.rows.map((row) => row.firebase_uid),
      ['survivor'],
      're-running migrations must not touch existing rows',
    );
  });

  it('is safe to run concurrently, the way two booting containers would', async () => {
    // The advisory lock in migrate() is what makes this survive: the second and
    // third callers wait, then find nothing left to apply.
    await Promise.all([h.migrate(), h.migrate(), h.migrate()]);
    assert.deepEqual(await h.appliedMigrations(), MIGRATIONS);
  });
});
