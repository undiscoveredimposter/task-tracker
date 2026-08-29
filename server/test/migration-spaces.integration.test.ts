import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { SKIP_REASON, startHarness, type Harness } from './helpers/harness.ts';

/**
 * What migration 004 does to data that already exists.
 *
 * The schema part of it is covered by the migrations suite building everything
 * from empty. This is the other half, and the half that cannot be inferred from
 * reading the DDL: three lists, two of them shared with the same person at
 * different roles, going into one space that can only hold one role for them.
 *
 * The choice was strongest-wins, so that nobody loses a capability they had
 * been using. That is a decision, not a detail — it is asserted here so it
 * cannot be quietly reversed.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const ALEX = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
const RILEY = '33333333-3333-3333-3333-333333333333';
const NOBODY = '44444444-4444-4444-4444-444444444444';
const KITCHEN = 'aaaaaaaa-0000-0000-0000-000000000001';
const GARAGE = 'aaaaaaaa-0000-0000-0000-000000000002';
const SAMS = 'bbbbbbbb-0000-0000-0000-000000000001';

describe('migration 004, on a database that was already in use', { skip: SKIP_REASON }, () => {
  let h: Harness;

  const apply = async (file: string) => {
    await h.sql.query(await readFile(join(migrationsDir, file), 'utf8'));
  };

  before(async () => {
    // Unmigrated: this suite applies them one at a time, so it can seed the
    // database as it stood the moment before 004 ran.
    h = await startHarness({ migrate: false });

    for (const file of [
      '001_init.sql',
      '002_task_positions.sql',
      '003_user_display_name_custom.sql',
    ]) {
      await apply(file);
    }

    await h.sql.query(
      `INSERT INTO users (id, firebase_uid, email, display_name) VALUES
         ($1, 'uid-alex',  'alex@example.test',  'Alex'),
         ($2, 'uid-sam',   'sam@example.test',   'Sam'),
         ($3, 'uid-riley', 'riley@example.test', ''),
         ($4, 'uid-none',  'none@example.test',  'Nobody')`,
      [ALEX, SAM, RILEY, NOBODY],
    );
    await h.sql.query(
      `INSERT INTO lists (id, name, owner_id) VALUES
         ($1, 'Kitchen', $4), ($2, 'Garage', $4), ($3, 'Sam only', $5)`,
      [KITCHEN, GARAGE, SAMS, ALEX, SAM],
    );
    await h.sql.query(
      `INSERT INTO list_members (list_id, user_id, role, joined_at) VALUES
         ($1, $4, 'owner',  '2026-01-01'),
         ($1, $5, 'editor', '2026-03-01'),
         ($1, $6, 'viewer', '2026-04-01'),
         ($2, $4, 'owner',  '2026-01-02'),
         ($2, $5, 'viewer', '2026-02-01'),
         ($3, $5, 'owner',  '2026-01-03')`,
      [KITCHEN, GARAGE, SAMS, ALEX, SAM, RILEY],
    );
    await h.sql.query(
      `INSERT INTO invites (list_id, token, role) VALUES ($1, 'tok-live', 'editor')`,
      [KITCHEN],
    );

    await apply('004_spaces.sql');
  });

  after(async () => {
    await h?.close();
  });

  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => {
    const { rows } = await h.sql.query<T>(sql, params);
    return rows[0];
  };

  it('gives everyone who owned a list a space named after them', async () => {
    const { rows } = await h.sql.query<{ name: string; owner_id: string }>(
      'SELECT name, owner_id FROM spaces ORDER BY name',
    );
    assert.deepEqual(
      rows.map((row) => row.name),
      ['Alex’s home', 'Sam’s home'],
    );
  });

  it('leaves an account that owned nothing without one', async () => {
    const mine = await one<{ count: number }>(
      'SELECT count(*)::int AS count FROM spaces WHERE owner_id = $1',
      [NOBODY],
    );
    assert.equal(mine?.count, 0, 'an empty account has nothing to share');
  });

  it('puts every list in its owner’s space', async () => {
    const { rows } = await h.sql.query<{ name: string; space: string }>(
      `SELECT l.name, s.name AS space FROM lists l JOIN spaces s ON s.id = l.space_id
        ORDER BY l.name`,
    );
    assert.deepEqual(rows, [
      { name: 'Garage', space: 'Alex’s home' },
      { name: 'Kitchen', space: 'Alex’s home' },
      { name: 'Sam only', space: 'Sam’s home' },
    ]);
  });

  it('merges two roles into the stronger one', async () => {
    // Sam was an editor on Kitchen and a viewer on Garage. Both are now one
    // space, and taking the weaker role would have removed edit access Sam had
    // yesterday — so the stronger one wins.
    const sam = await one<{ role: string; joined_at: Date }>(
      `SELECT m.role, m.joined_at FROM space_members m
         JOIN spaces s ON s.id = m.space_id
        WHERE s.owner_id = $1 AND m.user_id = $2`,
      [ALEX, SAM],
    );
    assert.equal(sam?.role, 'editor');
    assert.equal(
      sam?.joined_at.toISOString().slice(0, 10),
      '2026-02-01',
      'and "member since" keeps the earliest of the rows it merged',
    );
  });

  it('carries a single-list member across unchanged', async () => {
    const riley = await one<{ role: string }>(
      `SELECT m.role FROM space_members m JOIN spaces s ON s.id = m.space_id
        WHERE s.owner_id = $1 AND m.user_id = $2`,
      [ALEX, RILEY],
    );
    assert.equal(riley?.role, 'viewer');
  });

  it('keeps every space owner an owner of their own space', async () => {
    const { rows } = await h.sql.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM spaces s
        WHERE NOT EXISTS (
          SELECT 1 FROM space_members m
           WHERE m.space_id = s.id AND m.user_id = s.owner_id AND m.role = 'owner')`,
    );
    assert.equal(rows[0]?.count, 0);
  });

  it('revokes the links that were live, rather than widening what they grant', async () => {
    // A link created against one list would otherwise start letting people into
    // the whole space it landed in.
    const invite = await one<{ revoked_at: Date | null; space_id: string }>(
      'SELECT revoked_at, space_id FROM invites WHERE token = $1',
      ['tok-live'],
    );
    assert.ok(invite?.revoked_at, 'the outstanding link is revoked');
    assert.ok(invite?.space_id, 'and it now points at a space');
  });

  it('keeps the old membership rows, because the merge above cannot be undone', async () => {
    const legacy = await one<{ count: number }>(
      'SELECT count(*)::int AS count FROM list_members_legacy',
    );
    assert.equal(legacy?.count, 6);
  });

  it('leaves nothing private and nothing homeless', async () => {
    const loose = await one<{ count: number }>(
      'SELECT count(*)::int AS count FROM lists WHERE space_id IS NULL OR private',
    );
    assert.equal(loose?.count, 0);
  });
});
