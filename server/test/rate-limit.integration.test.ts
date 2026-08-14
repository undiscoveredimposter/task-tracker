import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  SKIP_REASON,
  createList,
  createTask,
  startHarness,
  type ApiResponse,
  type Harness,
  type SeededList,
  type TestUser,
} from './helpers/harness.ts';
import type { RateLimiter } from '../src/rate-limit.ts';

/**
 * The limiter's own behaviour is covered in rate-limit.test.ts, without a
 * database. What this file checks is the wiring: that the unlocked invite door
 * is guarded, that writes are, and — just as important — that the health check
 * and ordinary reads are not.
 *
 * The limits here are set absurdly low through the environment so a handful of
 * requests can cross them. The shipped defaults live in config.ts.
 */

const INVITE_LOOKUPS = 5;
const WRITES = 5;

interface CallOptions {
  method?: string;
  /** The address Coolify's proxy would report having seen. */
  from?: string;
  /** A signed-in uid, in the dev-auth token format the harness uses. */
  as?: string;
  body?: unknown;
}

describe('rate limiting', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let inviteLookupLimiter: RateLimiter;
  let writeLimiter: RateLimiter;
  let owner: TestUser;
  let list: SeededList;

  before(async () => {
    h = await startHarness({
      env: {
        RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE: String(INVITE_LOOKUPS),
        RATE_LIMIT_WRITES_PER_MINUTE: String(WRITES),
      },
    });
    // After the harness, so a run without a database skips rather than throwing
    // on config.ts's demand for DATABASE_URL at import time.
    ({ inviteLookupLimiter, writeLimiter } = await import('../src/limits.ts'));
  });

  after(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.truncate();
    owner = await h.signIn('owner');
    list = await createList(owner, { name: 'Home' });
    // Counters are module state and outlive truncate(); clearing them after the
    // seeding means every test starts with the full budget.
    inviteLookupLimiter.counter.reset();
    writeLimiter.counter.reset();
  });

  const call = async (path: string, options: CallOptions = {}) => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-forwarded-for': options.from ?? '203.0.113.1',
    };
    if (options.as) headers.authorization = `Bearer dev:${options.as}:${options.as}@example.test`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    return fetch(`${h.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };

  const inviteToken = async () => {
    const response = await owner.post<{ token: string }>(`/api/lists/${list.id}/invites`, {
      role: 'editor',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.token;
  };

  /* ── The unlocked door ─────────────────────────────────────────────────── */

  describe('invite lookups', () => {
    it('lets a household passing one link round get on with it', async () => {
      const token = await inviteToken();
      writeLimiter.counter.reset(); // creating the invite was a write

      // Open the link, join, open it again — the whole journey, twice over,
      // and still nowhere near the ceiling.
      const journey = [
        await call(`/api/invites/token/${token}`),
        await call(`/api/invites/token/${token}/accept`, { method: 'POST', as: 'guest' }),
        await call(`/api/invites/token/${token}`, { as: 'guest' }),
      ];
      for (const response of journey) {
        assert.notEqual(response.status, 429, await response.text());
      }
    });

    it('refuses a flood of guesses with 429, Retry-After and something readable', async () => {
      for (let i = 0; i < INVITE_LOOKUPS; i++) {
        const allowed = await call(`/api/invites/token/guess-${i}`);
        assert.equal(allowed.status, 200, `attempt ${i} should still be allowed`);
      }

      const refused = await call('/api/invites/token/guess-again');
      assert.equal(refused.status, 429);

      const retryAfter = refused.headers.get('retry-after');
      assert.ok(retryAfter, 'Retry-After is missing');
      assert.match(retryAfter, /^\d+$/);
      assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60, retryAfter);

      const body = (await refused.json()) as { error: string; code: string };
      assert.equal(body.code, 'rate_limited');
      assert.match(body.error, /try again/i);
    });

    it('keys on the forwarded address, so one flood cannot lock out everyone', async () => {
      // Every request in this process arrives from 127.0.0.1. If the limiter read
      // the socket instead of the forwarded header, Coolify's proxy would be a
      // single enormously busy caller and the second address below would already
      // be refused.
      for (let i = 0; i <= INVITE_LOOKUPS; i++) {
        await call(`/api/invites/token/guess-${i}`, { from: '203.0.113.1' });
      }
      assert.equal((await call('/api/invites/token/x', { from: '203.0.113.1' })).status, 429);
      assert.equal((await call('/api/invites/token/x', { from: '198.51.100.9' })).status, 200);
    });

    it('counts accepting against the same budget as looking up', async () => {
      const token = await inviteToken();

      for (let i = 0; i < INVITE_LOOKUPS; i++) {
        await call(`/api/invites/token/guess-${i}`);
      }

      const refused = await call(`/api/invites/token/${token}/accept`, {
        method: 'POST',
        as: 'guest',
      });
      // Not 401 and not 201: the limiter sits in front of the token check, so a
      // flood never reaches the database.
      assert.equal(refused.status, 429);
      assert.ok(refused.headers.get('retry-after'));
    });
  });

  /* ── Authenticated writes ──────────────────────────────────────────────── */

  describe('writes', () => {
    it('leaves an ordinary flurry of ticking alone', async () => {
      const task = await createTask(owner, list.id);

      const burst = [
        await owner.post(`/api/tasks/${task.id}/complete`),
        await owner.del(`/api/tasks/${task.id}/complete`),
        await owner.post(`/api/tasks/${task.id}/complete`),
      ];
      for (const response of burst) {
        assert.notEqual(response.status, 429, JSON.stringify(response.body));
      }
    });

    it('stops a runaway client with 429 and Retry-After', async () => {
      const task = await createTask(owner, list.id);

      let refused: ApiResponse<{ error: string; code: string }> | null = null;
      for (let i = 0; i < WRITES + 5; i++) {
        const response = await owner.post(`/api/tasks/${task.id}/complete`);
        if (response.status === 429) {
          refused = response;
          break;
        }
      }

      assert.ok(refused, `never refused after ${WRITES + 5} writes`);
      assert.match(refused.headers.get('retry-after') ?? '', /^\d+$/);
      assert.equal(refused.body.code, 'rate_limited');
      assert.match(refused.body.error, /try again/i);
    });

    it('charges writes to the person, not to the household address', async () => {
      const task = await createTask(owner, list.id);
      for (let i = 0; i < WRITES + 2; i++) await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await owner.post(`/api/tasks/${task.id}/complete`)).status, 429);

      // Same address, different phone, different person: still theirs to use.
      const partner = await h.signIn('partner');
      const theirList = await partner.post('/api/lists', { name: 'Theirs' });
      assert.equal(theirList.status, 201, JSON.stringify(theirList.body));
    });

    it('never refuses a read, however many writes have been spent', async () => {
      const task = await createTask(owner, list.id);
      for (let i = 0; i < WRITES + 2; i++) await owner.post(`/api/tasks/${task.id}/complete`);
      assert.equal((await owner.post(`/api/tasks/${task.id}/complete`)).status, 429);

      // Being locked out of *seeing* your own list because you ticked too fast
      // would be a far worse bug than the one this is defending against.
      assert.equal((await owner.get('/api/lists')).status, 200);
      assert.equal((await owner.get(`/api/lists/${list.id}`)).status, 200);
      assert.equal((await owner.get(`/api/lists/${list.id}/stats?window=7`)).status, 200);
    });
  });

  /* ── What must never be limited ────────────────────────────────────────── */

  it('never rate-limits the health check', async () => {
    // Coolify polls this every 15 seconds. A 429 here reads as a sick container
    // and takes the app out of rotation.
    for (let i = 0; i < WRITES * 8; i++) {
      const response = await call('/api/health');
      assert.equal(response.status, 200, `health check ${i} was refused`);
    }
  });
});
