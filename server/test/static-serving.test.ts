// Must come first: it registers the module-resolution hooks that let the
// dynamic import of `src/app.ts` reach its `./config.js`-style specifiers.
import '../scripts/ts-resolve.ts';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Serving the built PWA, driven through a real HTTP server against a real
 * directory on disk — because the bug this covers lived precisely in the gap
 * between what `express.static` thinks a relative path means and what
 * `res.sendFile` does, and no mock of either would have shown it.
 *
 * WEB_ROOT here is deliberately relative. Nothing in this file touches the
 * database: no route under `/api` is exercised, so the pool is never asked to
 * connect and DATABASE_URL only has to exist for config to load.
 */

/**
 * Relative, and below a dot-directory — both on purpose.
 *
 * Relative is the reported bug. The dot-directory is the second half of it:
 * `res.sendFile(absolutePath)` with no `root` runs send()'s dotfile rule over
 * every segment of the path, so an app installed under `/srv/.deploy`, a git
 * worktree under `.claude` or anything below `~/.cache` served its assets and
 * 404'd every page. Both failures look identical from a browser — the site is
 * up, and there are no pages.
 */
const WEB_ROOT = '.deploy/web/dist';

const SHELL =
  '<!doctype html><html><head><title>Tally</title></head>' +
  '<body><div id="root"></div></body></html>';
const ASSET = 'export const version = 1;\n';
const SERVICE_WORKER = "self.addEventListener('install', () => {});\n";

let server: Server;
let baseUrl: string;
let fixture: string;
let startedIn: string;

interface Fetched {
  status: number;
  body: string;
  contentType: string | null;
  cacheControl: string | null;
}

async function get(path: string): Promise<Fetched> {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
  };
}

describe('serving the built PWA from a relative WEB_ROOT', () => {
  before(async () => {
    startedIn = process.cwd();

    // realpath because chdir() reports the resolved directory, and on macOS the
    // temp directory is reached through a symlink.
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'tally-web-root-')));
    const dist = join(fixture, WEB_ROOT, 'assets');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(fixture, WEB_ROOT, 'index.html'), SHELL);
    writeFileSync(join(dist, 'index-a1b2c3.js'), ASSET);
    writeFileSync(join(fixture, WEB_ROOT, 'sw.js'), SERVICE_WORKER);

    // The shape of the report: someone runs the built server from a directory
    // and points WEB_ROOT at a path below it.
    process.chdir(fixture);
    process.env.WEB_ROOT = WEB_ROOT;
    process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
    process.env.NODE_ENV = 'test';
    process.env.TALLY_DEV_AUTH = '';

    const { createApp } = await import('../src/app.ts');

    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.closeAllConnections?.();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (startedIn) process.chdir(startedIn);
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });

  it('records WEB_ROOT as an absolute path', async () => {
    const { config } = await import('../src/config.ts');
    assert.equal(config.webRoot, join(fixture, WEB_ROOT));
    assert.ok(isAbsolute(config.webRoot));
  });

  describe('page navigations', () => {
    it('serves the app shell at the root', async () => {
      const response = await get('/');
      assert.equal(response.status, 200);
      assert.match(response.body, /<div id="root">/);
    });

    it('serves the app shell for a deep link the client routes itself', async () => {
      for (const path of ['/l/4a3f9b7e-0000-4000-8000-000000000000', '/settings', '/invite/abc123']) {
        const response = await get(path);
        assert.equal(response.status, 200, `${path} should serve the shell`);
        assert.match(response.body, /<div id="root">/, `${path} should serve the shell`);
      }
    });

    it('sends the shell as HTML, not as an error document', async () => {
      const response = await get('/');
      assert.match(response.contentType ?? '', /text\/html/);
    });

    it('keeps the shell uncached, so a deploy can reach a device that has it', async () => {
      assert.equal((await get('/')).cacheControl, 'no-cache');
    });

    it('answers a HEAD the same way', async () => {
      const response = await fetch(`${baseUrl}/`, { method: 'HEAD' });
      assert.equal(response.status, 200);
    });
  });

  describe('assets', () => {
    it('serves a hashed asset', async () => {
      const response = await get('/assets/index-a1b2c3.js');
      assert.equal(response.status, 200);
      assert.equal(response.body, ASSET);
    });

    it('marks hashed assets immutable', async () => {
      const response = await get('/assets/index-a1b2c3.js');
      assert.match(response.cacheControl ?? '', /immutable/);
    });

    it('serves the service worker, and never caches it', async () => {
      const response = await get('/sw.js');
      assert.equal(response.status, 200);
      assert.equal(response.body, SERVICE_WORKER);
      assert.equal(response.cacheControl, 'no-cache');
    });
  });

  describe('after the working directory moves', () => {
    it('still serves the shell and the assets it was configured with', async () => {
      // Resolution happens once, when config loads. A process that chdirs later
      // — or an npm script invoked from somewhere else — must not be able to
      // repoint a running server at a different directory, or serve nothing.
      process.chdir(tmpdir());
      try {
        const shell = await get('/');
        assert.equal(shell.status, 200);
        assert.match(shell.body, /<div id="root">/);

        const asset = await get('/assets/index-a1b2c3.js');
        assert.equal(asset.status, 200);
      } finally {
        process.chdir(fixture);
      }
    });
  });

  describe('the API', () => {
    it('still answers an unknown endpoint with JSON rather than the shell', async () => {
      const response = await get('/api/nope');
      assert.equal(response.status, 404);
      assert.deepEqual(JSON.parse(response.body), { error: 'No such endpoint' });
    });

    it('does not swallow a POST to an unknown page into the fallback', async () => {
      const response = await fetch(`${baseUrl}/definitely-not-a-page`, { method: 'POST' });
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /<div id="root">/);
    });
  });
});
