// Must come first: it registers the module-resolution hooks that let the
// dynamic import of `src/app.ts` reach its `./config.js`-style specifiers.
import '../scripts/ts-resolve.ts';

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

/**
 * An empty WEB_ROOT is the API-only mode the dev server and the integration
 * harness both run in — Vite serves the frontend there, and the harness needs
 * unknown paths to 404 rather than disappear behind an SPA fallback.
 *
 * It gets its own file because config reads the environment once per process,
 * and `node --test` gives each file a process of its own.
 */

let server: Server;
let baseUrl: string;

describe('with WEB_ROOT empty', () => {
  before(async () => {
    process.env.WEB_ROOT = '';
    process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused';
    process.env.NODE_ENV = 'test';

    const { config } = await import('../src/config.ts');
    assert.equal(config.webRoot, '', 'an empty WEB_ROOT must stay empty, not become the cwd');

    const { createApp } = await import('../src/app.ts');
    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.closeAllConnections?.();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves no app shell', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /<div id="root">/);
  });

  it('lets an unknown path 404 instead of swallowing it', async () => {
    assert.equal((await fetch(`${baseUrl}/l/anything`)).status, 404);
  });

  it('still answers the API', async () => {
    const response = await fetch(`${baseUrl}/api/nope`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'No such endpoint' });
  });
});
