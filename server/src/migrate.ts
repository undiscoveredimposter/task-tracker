import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

// dist/migrate.js and src/migrate.ts are both one level below the package root,
// so the same relative hop finds migrations/ in dev and in the built image.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Applies any migration files this database hasn't seen yet, in filename order.
 * Runs on boot before the server listens, so a deploy can never serve traffic
 * against a schema it doesn't expect.
 */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Serialise concurrent boots: with two containers starting at once, the
    // second waits here and then finds nothing left to apply.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['tally_migrations']);

    try {
      const applied = new Set(
        (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
          (row) => row.filename,
        ),
      );

      const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(join(migrationsDir, file), 'utf8');
        console.log(`[migrate] applying ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
        }
      }

      console.log(`[migrate] up to date (${files.length} migration(s))`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tally_migrations']);
    }
  } finally {
    client.release();
  }
}
