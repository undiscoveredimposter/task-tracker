import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import {
  formatLogLine,
  redactUrl,
  requestLogger,
  scrubSecrets,
  type RequestLogEntry,
} from '../src/request-log.ts';

/**
 * A log line is a thing that gets shipped somewhere, kept, and read by whoever
 * is on call. Two properties matter: it parses, and it never contains a working
 * credential. An invite token in a log is a key to somebody's list.
 */

const AT = '2026-08-13T09:00:00.000Z';

const entry = (overrides: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  event: 'request',
  time: AT,
  method: 'GET',
  path: '/api/lists',
  status: 200,
  ...overrides,
});

describe('redactUrl', () => {
  it('leaves an ordinary path alone', () => {
    assert.equal(redactUrl('/api/lists'), '/api/lists');
  });

  it('keeps list and task ids, which are what makes a line worth reading', () => {
    const id = '9f8b2c3d-1111-4222-8333-444455556666';
    assert.equal(redactUrl(`/api/tasks/${id}/complete`), `/api/tasks/${id}/complete`);
  });

  it('replaces the invite token in an API path', () => {
    assert.equal(redactUrl('/api/invites/token/RUW1TX9ip_lFcbA'), '/api/invites/token/:token');
  });

  it('replaces it on the accept path too, keeping the rest of the route', () => {
    assert.equal(
      redactUrl('/api/invites/token/RUW1TX9ip_lFcbA/accept'),
      '/api/invites/token/:token/accept',
    );
  });

  it('replaces the token in the invite link people actually open', () => {
    // /j/<token> is served by the SPA fallback, so the token reaches the access
    // log through a static request rather than an API one.
    assert.equal(redactUrl('/j/RUW1TX9ip_lFcbA'), '/j/:token');
    assert.equal(redactUrl('/invite/RUW1TX9ip_lFcbA'), '/invite/:token');
  });

  it('leaves the invite id on the revoke route, which is not a secret', () => {
    const id = '9f8b2c3d-1111-4222-8333-444455556666';
    assert.equal(redactUrl(`/api/invites/${id}`), `/api/invites/${id}`);
  });

  it('keeps a useful query string', () => {
    assert.equal(redactUrl('/api/lists/abc/stats?window=30'), '/api/lists/abc/stats?window=30');
  });

  it('redacts anything query-shaped that smells like a credential', () => {
    assert.equal(redactUrl('/x?token=RUW1TX9ip'), '/x?token=[redacted]');
    assert.equal(redactUrl('/x?window=7&apiKey=abc'), '/x?window=7&apiKey=[redacted]');
    assert.equal(redactUrl('/x?oobCode=abc&mode=signIn'), '/x?oobCode=[redacted]&mode=signIn');
  });

  it('survives a path with a token and a query at once', () => {
    assert.equal(redactUrl('/j/RUW1TX9ip?ref=chat'), '/j/:token?ref=chat');
  });
});

describe('scrubSecrets', () => {
  it('removes a bearer credential wherever it turns up', () => {
    assert.equal(scrubSecrets('auth=Bearer abc.def.ghi'), 'auth=Bearer [redacted]');
  });

  it('removes a JWT-shaped string on its own', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJl';
    assert.equal(scrubSecrets(`path=/x/${jwt}`), 'path=/x/[redacted]');
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(scrubSecrets('GET /api/lists 200 4ms'), 'GET /api/lists 200 4ms');
  });
});

describe('formatLogLine', () => {
  it('emits one line of JSON that parses', () => {
    const line = formatLogLine(entry({ durationMs: 12, userId: 'u-1' }), 'json');
    assert.ok(!line.includes('\n'));
    assert.deepEqual(JSON.parse(line), {
      time: AT,
      level: 'info',
      event: 'request',
      method: 'GET',
      path: '/api/lists',
      status: 200,
      durationMs: 12,
      userId: 'u-1',
    });
  });

  it('leaves userId out rather than sending null for a signed-out caller', () => {
    const parsed = JSON.parse(formatLogLine(entry({ status: 401 }), 'json'));
    assert.ok(!('userId' in parsed));
  });

  it('grades the level by status, so a 500 can be alerted on', () => {
    assert.equal(JSON.parse(formatLogLine(entry({ status: 200 }), 'json')).level, 'info');
    assert.equal(JSON.parse(formatLogLine(entry({ status: 404 }), 'json')).level, 'warn');
    assert.equal(JSON.parse(formatLogLine(entry({ status: 503 }), 'json')).level, 'error');
  });

  it('reads as a sentence in development', () => {
    const line = formatLogLine(entry({ durationMs: 12, userId: 'u-1' }), 'text');
    assert.ok(line.includes('GET /api/lists 200'));
    assert.ok(line.includes('12ms'));
    assert.ok(line.includes('user=u-1'));
  });

  it('scrubs credential-shaped text out of either format', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJl';
    for (const format of ['json', 'text'] as const) {
      const line = formatLogLine(entry({ path: `/x/${jwt}` }), format);
      assert.ok(!line.includes(jwt), `${format} leaked a token`);
    }
  });
});

/* ── The middleware, against a real server ───────────────────────────────── */

describe('requestLogger', () => {
  let server: Server;
  let baseUrl: string;
  let lines: string[] = [];
  let clock = 0;
  let healthStatus = 200;
  let streamStatus = 200;

  before(async () => {
    const app = express();
    app.use(
      requestLogger({
        format: 'json',
        write: (line) => lines.push(line),
        monotonic: () => clock,
        wallClock: () => new Date(AT),
      }),
    );

    app.get('/api/health', (_req, res) => {
      clock += 3;
      res.status(healthStatus).json({ ok: healthStatus < 400 });
    });
    app.get('/api/boom', (_req, res) => {
      res.status(503).json({ ok: false });
    });
    app.get('/api/me', (req, res) => {
      // Stands in for requireAuth, which attaches the user after this middleware
      // has already run — the id has to be read at the end of the request.
      (req as { user?: { id: string } }).user = { id: 'u-42' };
      clock += 7;
      res.json({ id: 'u-42' });
    });
    app.get('/api/invites/token/:token', (_req, res) => {
      res.json({ status: 'not_found' });
    });
    app.get('/api/stream', (_req, res) => {
      if (streamStatus >= 400) {
        // What requireAuth does to a stream request with no token.
        res.status(streamStatus).json({ error: 'Sign in to continue' });
        return;
      }
      clock += 2;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      // Deliberately left open, the way a real SSE connection is.
    });

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    lines = [];
    clock = 0;
    healthStatus = 200;
    streamStatus = 200;
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    await response.text();
    return response;
  };

  /** Waits for the log line, which lands on response 'finish', not on fetch resolving. */
  const settled = async (count = 1): Promise<Record<string, any>[]> => {
    for (let attempt = 0; attempt < 100 && lines.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return lines.map((line) => JSON.parse(line));
  };

  it('writes exactly one line per request', async () => {
    await get('/api/me');
    const logged = await settled();
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0], {
      time: AT,
      level: 'info',
      event: 'request',
      method: 'GET',
      path: '/api/me',
      status: 200,
      durationMs: 7,
      userId: 'u-42',
    });
  });

  it('records the status of a failure', async () => {
    await get('/api/boom');
    const [logged] = await settled();
    assert.equal(logged?.status, 503);
    assert.equal(logged?.level, 'error');
  });

  it('says nothing about a healthy health check', async () => {
    // Coolify polls this every 15 seconds. Logged, it is 5,760 lines a day that
    // nobody reads and that bury the ones somebody needs.
    await get('/api/health');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(lines, []);
  });

  it('still reports a health check that failed', async () => {
    // Quiet is not the same as blind: the one time this endpoint is interesting
    // is the moment it starts answering 503.
    healthStatus = 503;
    await get('/api/health');
    const [logged] = await settled();
    assert.equal(logged?.path, '/api/health');
    assert.equal(logged?.status, 503);
  });

  it('never reads the Authorization header, let alone logs it', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJl';
    const token = 'RUW1TX9ip_lFcbAzQ0k7Yg';
    await get(`/api/invites/token/${token}`, {
      authorization: `Bearer ${jwt}`,
      cookie: 'session=hunter2',
    });

    const logged = await settled();
    const raw = lines.join('\n');
    assert.ok(!raw.includes(jwt), 'the ID token reached the log');
    assert.ok(!raw.includes(token), 'the invite token reached the log');
    assert.ok(!raw.toLowerCase().includes('authorization'));
    assert.ok(!raw.includes('hunter2'));
    assert.equal(logged[0]?.path, '/api/invites/token/:token');
  });

  it('logs an SSE connection once, when it opens, and not for its duration', async () => {
    // A stream lives for hours. Logging it on finish would record a single line
    // with a duration measured in hours, long after it was any use.
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);

    const logged = await settled();
    assert.equal(logged.length, 1);
    assert.equal(logged[0]?.event, 'stream.open');
    assert.equal(logged[0]?.status, 200);
    assert.ok(!('durationMs' in (logged[0] ?? {})));

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(lines.length, 1, 'closing the stream logged a second line');
  });

  it('logs a rejected stream as the ordinary finished request it is', async () => {
    streamStatus = 401;
    const response = await get('/api/stream');
    assert.equal(response.status, 401);

    const [logged] = await settled();
    assert.equal(logged?.event, 'request');
    assert.equal(logged?.status, 401);
    assert.equal(logged?.durationMs, 0);
  });
});
