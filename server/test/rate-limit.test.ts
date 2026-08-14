import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import {
  clientAddress,
  FixedWindowCounter,
  isSafeMethod,
  normaliseAddress,
  rateLimit,
} from '../src/rate-limit.ts';

/**
 * These are deliberately free of the database and of `config.ts` — the limiter
 * imports nothing from the rest of the app, so the whole of it, middleware
 * included, can be exercised without a Postgres. Wiring (which limiter guards
 * which route) is covered by rate-limit.integration.test.ts instead.
 */

describe('FixedWindowCounter', () => {
  const counter = () => new FixedWindowCounter({ limit: 3, windowMs: 60_000 });

  it('allows requests up to the limit and refuses the one after', () => {
    const limiter = counter();
    assert.equal(limiter.hit('a', 0).allowed, true);
    assert.equal(limiter.hit('a', 1).allowed, true);
    assert.equal(limiter.hit('a', 2).allowed, true);
    assert.equal(limiter.hit('a', 3).allowed, false);
  });

  it('counts down what is left and never goes below zero', () => {
    const limiter = counter();
    assert.equal(limiter.hit('a', 0).remaining, 2);
    assert.equal(limiter.hit('a', 0).remaining, 1);
    assert.equal(limiter.hit('a', 0).remaining, 0);
    assert.equal(limiter.hit('a', 0).remaining, 0);
    assert.equal(limiter.hit('a', 0).remaining, 0);
  });

  it('gives every key its own budget', () => {
    const limiter = counter();
    for (let i = 0; i < 5; i++) limiter.hit('busy', 0);

    assert.equal(limiter.hit('busy', 0).allowed, false);
    // The whole point of keying on the caller: one flood must not lock out
    // everyone else who happens to be using the app at the time.
    assert.equal(limiter.hit('quiet', 0).allowed, true);
  });

  it('starts a fresh budget once the window has passed', () => {
    const limiter = counter();
    for (let i = 0; i < 4; i++) limiter.hit('a', 0);
    assert.equal(limiter.hit('a', 59_999).allowed, false);
    assert.equal(limiter.hit('a', 60_000).allowed, true);
  });

  it('reports whole seconds until the caller may retry', () => {
    const limiter = counter();
    for (let i = 0; i < 3; i++) limiter.hit('a', 0);

    // 60s window opened at t=0; at t=1500 there are 58.5s left, and a client
    // told "58" would come back half a second early — always round up.
    assert.equal(limiter.hit('a', 1_500).retryAfterSeconds, 59);
    assert.equal(limiter.hit('a', 59_100).retryAfterSeconds, 1);
  });

  it('never says retry after zero seconds, which would mean retry immediately', () => {
    const limiter = new FixedWindowCounter({ limit: 1, windowMs: 100 });
    limiter.hit('a', 0);
    const verdict = limiter.hit('a', 99.9);
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.retryAfterSeconds >= 1, `got ${verdict.retryAfterSeconds}`);
  });

  it('leaves retryAfterSeconds at zero while the caller is within budget', () => {
    assert.equal(counter().hit('a', 0).retryAfterSeconds, 0);
  });

  it('forgets keys whose window has expired, so idle callers cost no memory', () => {
    const limiter = counter();
    for (const key of ['a', 'b', 'c']) limiter.hit(key, 0);
    assert.equal(limiter.size, 3);

    // The sweep is lazy — it happens on the next hit after a window's worth of
    // time, not on a timer that would keep the process alive.
    limiter.hit('d', 120_000);
    assert.equal(limiter.size, 1);
  });

  it('stays bounded when a flood arrives from thousands of distinct callers', () => {
    const limiter = new FixedWindowCounter({ limit: 3, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 5_000; i++) limiter.hit(`caller-${i}`, 0);
    assert.ok(limiter.size <= 100, `grew to ${limiter.size}`);
  });

  it('sheds the least recently active callers first when it evicts', () => {
    const limiter = new FixedWindowCounter({ limit: 5, windowMs: 60_000, maxKeys: 2 });
    limiter.hit('old', 0);
    limiter.hit('regular', 1);
    // 'regular' rolls into a new window, which should move it to the back of the
    // eviction queue; 'old' has not been seen since and should go first.
    limiter.hit('regular', 60_001);
    limiter.hit('new', 60_002);

    assert.equal(limiter.size, 2);
    assert.equal(limiter.hit('regular', 60_003).remaining, 3, "'regular' was evicted");
  });

  it('can be emptied', () => {
    const limiter = counter();
    for (let i = 0; i < 4; i++) limiter.hit('a', 0);
    limiter.reset();
    assert.equal(limiter.size, 0);
    assert.equal(limiter.hit('a', 0).allowed, true);
  });

  it('refuses a configuration that could never allow a request', () => {
    assert.throws(() => new FixedWindowCounter({ limit: 0, windowMs: 60_000 }), /at least one/i);
    assert.throws(() => new FixedWindowCounter({ limit: 3, windowMs: 0 }), /window/i);
  });
});

describe('normaliseAddress', () => {
  it('treats an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // Otherwise a caller reaching us over a v6 socket gets a second budget.
    assert.equal(normaliseAddress('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(normaliseAddress('203.0.113.7'), '203.0.113.7');
  });

  it('folds case and trims, so one caller is one bucket', () => {
    assert.equal(normaliseAddress('  2001:DB8::1  '), '2001:db8::1');
  });

  it('falls back to a placeholder rather than an empty key', () => {
    assert.equal(normaliseAddress(''), 'unknown');
    assert.equal(normaliseAddress('   '), 'unknown');
  });
});

describe('clientAddress', () => {
  it('prefers what Express resolved from the forwarded headers', () => {
    const req = { ip: '::ffff:203.0.113.7', socket: { remoteAddress: '10.0.0.1' } };
    assert.equal(clientAddress(req as never), '203.0.113.7');
  });

  it('falls back to the socket when there is no resolved ip', () => {
    const req = { ip: undefined, socket: { remoteAddress: '10.0.0.1' } };
    assert.equal(clientAddress(req as never), '10.0.0.1');
  });
});

describe('isSafeMethod', () => {
  it('knows which verbs only read', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      assert.equal(isSafeMethod({ method } as never), true, method);
    }
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      assert.equal(isSafeMethod({ method } as never), false, method);
    }
  });
});

/* ── The middleware, over a real socket ──────────────────────────────────── */

describe('rateLimit middleware', () => {
  const limiter = rateLimit({
    limit: 2,
    windowMs: 60_000,
    message: 'Slow down a moment.',
  });

  const writes = rateLimit({
    limit: 1,
    windowMs: 60_000,
    message: 'Too many changes.',
    skip: isSafeMethod,
  });

  let server: Server;
  let baseUrl: string;

  before(async () => {
    const app = express();
    // Mirrors app.ts: Coolify terminates TLS in front of us.
    app.set('trust proxy', 1);
    app.use('/limited', limiter);
    app.use('/writes', writes);
    app.use('/open', (_req, res) => res.json({ ok: true }));
    app.use((_req, res) => res.json({ ok: true }));

    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    limiter.counter.reset();
    writes.counter.reset();
  });

  const call = (path: string, forwardedFor?: string, method = 'GET') =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });

  it('lets normal use straight through', async () => {
    assert.equal((await call('/limited', '203.0.113.1')).status, 200);
    assert.equal((await call('/limited', '203.0.113.1')).status, 200);
  });

  it('answers 429 with Retry-After and a message a person would understand', async () => {
    await call('/limited', '203.0.113.1');
    await call('/limited', '203.0.113.1');

    const response = await call('/limited', '203.0.113.1');
    assert.equal(response.status, 429);

    const retryAfter = response.headers.get('retry-after');
    assert.ok(retryAfter, 'Retry-After header is missing');
    // Must be delta-seconds, not a date — the client and the server disagreeing
    // about the wall clock is the whole reason period keys are server-side.
    assert.match(retryAfter, /^\d+$/);
    assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, retryAfter);

    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.error, 'Slow down a moment.');
    // Same shape errorHandler produces, so the client needs no special case.
    assert.equal(body.code, 'rate_limited');
  });

  it('keys on the forwarded client address, not the socket', async () => {
    // Every request here arrives from 127.0.0.1. If the limiter looked at the
    // socket, Coolify's proxy would be one very busy caller and the second
    // household below would be locked out by the first.
    for (let i = 0; i < 3; i++) await call('/limited', '203.0.113.1');
    assert.equal((await call('/limited', '203.0.113.1')).status, 429);
    assert.equal((await call('/limited', '198.51.100.9')).status, 200);
  });

  it('reads the client end of a forwarded chain', async () => {
    // One trusted proxy: the rightmost entry is the address it saw.
    for (let i = 0; i < 3; i++) await call('/limited', '198.51.100.5, 203.0.113.2');
    assert.equal((await call('/limited', '198.51.100.5, 203.0.113.2')).status, 429);
    assert.equal((await call('/limited', '198.51.100.5, 203.0.113.3')).status, 200);
  });

  it('advertises the budget on every response', async () => {
    const response = await call('/limited', '203.0.113.4');
    assert.equal(response.headers.get('ratelimit-limit'), '2');
    assert.equal(response.headers.get('ratelimit-remaining'), '1');
    assert.ok(Number(response.headers.get('ratelimit-reset')) > 0);
  });

  it('leaves routes it is not mounted on alone', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await call('/open', '203.0.113.1')).status, 200);
    }
  });

  it('waves reads past when told to guard writes only', async () => {
    for (let i = 0; i < 10; i++) {
      assert.equal((await call('/writes', '203.0.113.5')).status, 200);
    }
    assert.equal((await call('/writes', '203.0.113.5', 'POST')).status, 200);
    assert.equal((await call('/writes', '203.0.113.5', 'POST')).status, 429);
  });

  it('can charge a request to something other than the address', async () => {
    const perUser = rateLimit({
      limit: 1,
      windowMs: 60_000,
      message: 'Too many changes.',
      keyFor: (req) => req.header('x-test-user') ?? 'anonymous',
    });

    const app = express();
    app.use(perUser);
    app.use((_req, res) => res.json({ ok: true }));
    const scratch = app.listen(0, '127.0.0.1');
    await once(scratch, 'listening');
    const url = `http://127.0.0.1:${(scratch.address() as AddressInfo).port}/`;

    const as = (user: string) => fetch(url, { headers: { 'x-test-user': user } });
    assert.equal((await as('alex')).status, 200);
    assert.equal((await as('alex')).status, 429);
    // Two people on one home connection share an address but not a budget.
    assert.equal((await as('sam')).status, 200);

    scratch.closeAllConnections?.();
    await new Promise<void>((resolve) => scratch.close(() => resolve()));
  });
});
