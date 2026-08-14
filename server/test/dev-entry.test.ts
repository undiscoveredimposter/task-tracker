/**
 * Guards the one thing that makes `npm run dev -w @tally/server` work.
 *
 * TypeScript's NodeNext module resolution makes us write `./app.js` in the
 * source, and Node's native type stripping does not rewrite that back to
 * `./app.ts`. Run `src/index.ts` without a resolution hook and the process dies
 * with ERR_MODULE_NOT_FOUND before a single line of ours executes.
 *
 * So this test runs the real `dev` script out of package.json — minus
 * `--watch`, which never exits — with DATABASE_URL deliberately unset. Node
 * resolves the *entire* module graph before evaluating any of it, so reaching
 * config.ts's "missing DATABASE_URL" is proof that every `.js` specifier and
 * `@tally/shared` resolved. If someone drops the hook from the dev script, this
 * fails with the module-not-found error instead.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);

const serverRoot = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', serverRoot), 'utf8')) as {
  scripts: Record<string, string>;
};

const devScript = pkg.scripts.dev ?? '';
const devArgs = devScript.split(/\s+/).filter(Boolean);

test('the dev script is a plain `node` invocation we can exercise here', () => {
  assert.equal(devArgs[0], 'node', `expected the dev script to start with node, got ${devScript}`);
  assert.ok(devArgs.includes('--watch'), 'dev should still hot-reload');
  assert.ok(devArgs.at(-1)?.endsWith('.ts'), 'dev should run the TypeScript entrypoint from src/');
});

test('running the dev entrypoint resolves the whole src/ module graph', async () => {
  const args = devArgs.slice(1).filter((arg) => arg !== '--watch');

  // Unset rather than bogus: a fake connection string would make us wait on a
  // TCP timeout. An absent one throws synchronously in config.ts, which is far
  // enough past resolution to prove the point.
  const env = { ...process.env };
  delete env.DATABASE_URL;

  const result = await run('node', args, { cwd: serverRoot, env, timeout: 30_000 }).then(
    () => ({ ok: true, output: '' }),
    (error: { stdout?: string; stderr?: string }) => ({
      ok: false,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    }),
  );

  assert.equal(result.ok, false, 'expected the entrypoint to bail out without a DATABASE_URL');
  assert.doesNotMatch(
    result.output,
    /ERR_MODULE_NOT_FOUND/,
    `dev entrypoint failed to resolve its imports:\n${result.output}`,
  );
  assert.match(
    result.output,
    /Missing required environment variable DATABASE_URL/,
    `expected to reach config validation, got:\n${result.output}`,
  );
});
