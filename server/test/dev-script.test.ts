import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The developer loop, guarded from the outside.
 *
 * `src/` is compiled with `module: NodeNext`, so every internal import is
 * written `./app.js` — a file that only exists in `dist/`. Node 22 runs `.ts`
 * files natively but does not rewrite that specifier, so running `src/index.ts`
 * directly used to die before evaluating a single line (#33).
 *
 * The end-to-end tests take the dev command out of `package.json` rather than
 * restating it, so the script and its coverage cannot drift apart: change how
 * dev starts and these run the new thing.
 */

const SERVER_ROOT = new URL('../', import.meta.url);
const RESOLVER = new URL('src/dev-resolve.ts', SERVER_ROOT);

/** The `dev` script split into argv. Kept simple: the script has no quoting. */
async function devCommand(): Promise<string[]> {
  const pkg = JSON.parse(await readFile(new URL('package.json', SERVER_ROOT), 'utf8'));
  const argv: string[] = pkg.scripts.dev.trim().split(/\s+/);
  assert.equal(
    argv[0],
    'node',
    `the dev script should invoke node directly, got: ${pkg.scripts.dev}`,
  );
  return argv;
}

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], options: { cwd: URL | string; env?: NodeJS.ProcessEnv }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`did not exit within 30s.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('the dev script', () => {
  it('reloads on a change, which is the only reason to run from src at all', async () => {
    const argv = await devCommand();

    assert.ok(argv.includes('--watch'), `dev should watch for changes, got: ${argv.join(' ')}`);
    assert.ok(
      argv.at(-1)?.startsWith('src/'),
      `dev should run the TypeScript source, not a build artefact, got: ${argv.join(' ')}`,
    );
  });

  it('resolves the whole server module graph without a build', async () => {
    // `--watch` never exits, so drop it; every other argument — the resolver
    // hook, the entry point — is exactly what `npm run dev` uses.
    const argv = (await devCommand()).slice(1).filter((arg) => arg !== '--watch');

    // No DATABASE_URL, so config.ts throws the moment the graph is evaluated.
    // That is the point: ESM resolves every specifier in a graph *before* it
    // evaluates any of it, so reaching the config error proves that nothing —
    // app.js, the routers, @tally/shared — failed to resolve. It also keeps
    // this test free of a database.
    const env = { ...process.env };
    delete env.DATABASE_URL;

    const { code, stderr } = await run(argv, { cwd: SERVER_ROOT, env });

    assert.doesNotMatch(
      stderr,
      /ERR_MODULE_NOT_FOUND/,
      'a `.js` specifier in src/ did not resolve to its `.ts` source — this is #33',
    );
    assert.match(
      stderr,
      /Missing required environment variable DATABASE_URL/,
      'expected the entry point to get as far as validating its environment',
    );
    assert.equal(code, 1);
  });
});

describe('the dev/test resolver hook', () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** A throwaway directory with the given files, plus an entry that prints. */
  async function sandbox(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'tally-resolve-'));
    dirs.push(dir);
    await Promise.all(
      Object.entries(files).map(([name, body]) => writeFile(join(dir, name), body)),
    );
    return dir;
  }

  const runEntry = (dir: string) =>
    run(['--import', pathToFileURL(RESOLVER.pathname).href, 'entry.ts'], { cwd: dir });

  it('falls back from a .js specifier to the .ts source beside it', async () => {
    const dir = await sandbox({
      'entry.ts': `import { who } from './thing.js';\nconsole.log(who);\n`,
      'thing.ts': `export const who: string = 'source';\n`,
    });

    const { code, stdout, stderr } = await runEntry(dir);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'source');
  });

  it('prefers a real .js when one exists, so a built workspace runs what it built', async () => {
    const dir = await sandbox({
      'entry.ts': `import { who } from './thing.js';\nconsole.log(who);\n`,
      'thing.ts': `export const who: string = 'source';\n`,
      'thing.js': `export const who = 'built';\n`,
      'package.json': `{ "type": "module" }`,
    });

    const { code, stdout, stderr } = await runEntry(dir);
    assert.equal(code, 0, stderr);
    assert.equal(
      stdout.trim(),
      'built',
      'the hook must only be a fallback — a built artefact still wins',
    );
  });

  it('falls back to the @tally/shared source when its dist is not resolvable', async () => {
    // Nothing above a temp directory provides @tally/shared, so the normal
    // resolution fails and only the hook can answer.
    const dir = await sandbox({
      'entry.ts': `import { LIST_COLORS } from '@tally/shared';\nconsole.log(Array.isArray(LIST_COLORS));\n`,
    });

    const { code, stdout, stderr } = await runEntry(dir);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), 'true');
  });

  it('leaves an unrelated missing module alone', async () => {
    const dir = await sandbox({
      'entry.ts': `import 'nope-this-does-not-exist';\n`,
    });

    const { code, stderr } = await runEntry(dir);
    assert.equal(code, 1);
    assert.match(stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
  });
});
