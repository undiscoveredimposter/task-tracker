// Registers the resolution hooks that let this file import `src/*.ts`.
import './helpers/ts-resolve.ts';

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The wired app, not the middleware in isolation: headers only protect anything
 * if they are mounted ahead of the routes, survive the error handler, and reach
 * the static files as well as the API.
 *
 * No Postgres needed. DATABASE_URL points at a closed port, so `pg` builds a
 * pool and never connects; every route asserted on here answers before it would
 * have needed the database (404, 401) or reports the failure itself (503 from
 * the health check). That keeps this suite running everywhere, which matters
 * for a test whose job is to notice a header quietly going missing.
 */

const INLINE_SCRIPT = "\n      document.documentElement.dataset.theme = 'dark';\n    ";
const webRoot = mkdtempSync(join(tmpdir(), 'tally-web-'));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(
  join(webRoot, 'index.html'),
  `<!doctype html><html><head><script>${INLINE_SCRIPT}</script>` +
    `<script type="module" src="/assets/app.js"></script></head><body></body></html>`,
);
writeFileSync(join(webRoot, 'assets', 'app.js'), 'export const app = 1;\n');

// Read once at import time by config.ts, so they have to be set before the
// dynamic imports below.
process.env.DATABASE_URL = 'postgresql://tally:tally@127.0.0.1:1/tally_unreachable';
process.env.NODE_ENV = 'test';
process.env.WEB_ROOT = webRoot;
process.env.FIREBASE_PROJECT_ID = 'tally-demo';
process.env.FIREBASE_AUTH_DOMAIN = '';
process.env.APP_ORIGIN = 'http://tally.test';

describe('security headers on the wired app', () => {
  let server: Server;
  let baseUrl: string;
  let pool: { end(): Promise<void> };

  before(async () => {
    ({ pool } = (await import('../src/db.ts')) as never);
    const { createApp } = await import('../src/app.ts');
    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end().catch(() => {});
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body };
  };

  const assertBaseline = (headers: Headers, where: string) => {
    assert.equal(headers.get('x-content-type-options'), 'nosniff', where);
    assert.equal(headers.get('x-frame-options'), 'DENY', where);
    assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin', where);
    assert.equal(headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups', where);
    assert.ok(headers.get('content-security-policy'), `${where}: no policy`);
    assert.equal(headers.get('x-powered-by'), null, where);
  };

  it('covers an API 404', async () => {
    const response = await get('/api/nope');
    assert.equal(response.status, 404);
    assertBaseline(response.headers, 'api 404');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });

  it('covers a rejected request, which is answered by the error handler', async () => {
    const response = await get('/api/me');
    assert.equal(response.status, 401);
    assertBaseline(response.headers, 'api 401');
  });

  it('covers a 503 from a route that reached for the database and failed', async () => {
    const response = await get('/api/health');
    assert.equal(response.status, 503);
    assertBaseline(response.headers, 'health 503');
  });

  it('covers the app shell, with a policy that permits its own inline script', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assertBaseline(response.headers, 'index.html');

    const policy = response.headers.get('content-security-policy') ?? '';
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(INLINE_SCRIPT, 'utf8').digest('base64');
    assert.ok(
      policy.includes(`'sha256-${hash}'`),
      'the inline theme script is not allowed by the policy it is served with',
    );
    assert.ok(policy.includes('https://apis.google.com'), 'Firebase popup loader blocked');
  });

  it('derives the Firebase frame source from the project id', async () => {
    const policy = (await get('/')).headers.get('content-security-policy') ?? '';
    assert.match(policy, /frame-src 'self' https:\/\/tally-demo\.firebaseapp\.com/);
  });

  it('covers the SPA fallback that serves an invite link', async () => {
    const response = await get('/j/RUW1TX9ip_lFcbAzQ0k7Yg');
    assert.equal(response.status, 200);
    assertBaseline(response.headers, 'invite landing');
  });

  it('covers a hashed asset without disturbing its caching', async () => {
    const response = await get('/assets/app.js');
    assert.equal(response.status, 200);
    assertBaseline(response.headers, 'asset');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('does not pin HSTS on a plaintext request', async () => {
    assert.equal((await get('/api/nope')).headers.get('strict-transport-security'), null);
  });

  it('keeps token material out of what the app writes to stdout', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJl';
    const token = 'RUW1TX9ip_lFcbAzQ0k7Yg';

    const captured: string[] = [];
    const realStdout = process.stdout.write.bind(process.stdout);
    const realStderr = process.stderr.write.bind(process.stderr);
    const capture =
      (): typeof process.stdout.write =>
      (chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        const callback = rest.find((argument) => typeof argument === 'function');
        if (typeof callback === 'function') (callback as () => void)();
        return true;
      };

    process.stdout.write = capture();
    process.stderr.write = capture();
    try {
      // Reaches for the database and fails, so it exercises the noisiest path
      // there is: an unauthenticated request carrying an invite token in its
      // path, ending in a 500 that the error handler also writes out.
      await get(`/api/invites/token/${token}`);
      // The invite landing page, served by the static fallback, with a bearer
      // header attached the way the app sends one once you are signed in.
      await get(`/j/${token}`, { authorization: `Bearer ${jwt}` });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    }

    const written = captured.join('');
    assert.ok(written.length > 0, 'the app logged nothing at all');
    assert.ok(!written.includes(jwt), 'an ID token was written to the log');
    assert.ok(!written.includes(token), 'an invite token was written to the log');
    assert.ok(!/bearer /i.test(written), 'a credential header reached the log');
    assert.ok(written.includes('/j/:token'), 'the invite path was not redacted, it was dropped');
  });
});
