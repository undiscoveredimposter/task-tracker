import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Per-caller request budgets, held in memory.
 *
 * This module deliberately imports nothing else from the app — not config, not
 * the error types. It is the one piece of middleware that has to work before
 * anything expensive happens, and keeping it self-contained also means the whole
 * of it, middleware included, is testable without a database.
 *
 * **In-memory is a decision, not an omission.** It matches the single-instance
 * assumption the SSE registry already makes (PLAN §6): two app containers would
 * each keep their own counters, so a caller would get roughly double the budget.
 * That is still far better than no limit, and the day we run two instances this
 * moves to Postgres alongside the SSE map. Standing up Redis to protect one box
 * would be the wrong trade.
 *
 * The window is **fixed**, not sliding. A caller who spends their whole budget
 * at the end of one window and again at the start of the next can briefly manage
 * twice the limit. For a backstop against hammering that is fine, and it costs
 * one small object per caller rather than a timestamp per request.
 */

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests left in this window, this one included. Never negative. */
  remaining: number;
  /** Whole seconds until the window rolls over. Zero while allowed, else >= 1. */
  retryAfterSeconds: number;
  /** Epoch ms at which this caller's window resets. */
  resetAt: number;
}

export interface FixedWindowOptions {
  /** Requests allowed per window, per key. */
  limit: number;
  windowMs: number;
  /** Ceiling on tracked keys, so a flood of addresses can't exhaust memory. */
  maxKeys?: number;
}

interface CounterWindow {
  count: number;
  resetAt: number;
}

/**
 * Ten thousand callers is far more than this app will ever see at once and still
 * only a few hundred kilobytes. Past it we start forgetting the least recently
 * active, which at worst hands a budget back to someone who had spent it.
 */
const DEFAULT_MAX_KEYS = 10_000;

export class FixedWindowCounter {
  readonly limit: number;
  readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly windows = new Map<string, CounterWindow>();
  private sweepAfter = 0;

  constructor(options: FixedWindowOptions) {
    if (!Number.isFinite(options.limit) || options.limit < 1) {
      throw new Error(`A rate limit must allow at least one request, got ${options.limit}`);
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new Error(`A rate limit window must be positive, got ${options.windowMs}`);
    }

    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Number of callers currently being tracked. For tests and diagnostics. */
  get size(): number {
    return this.windows.size;
  }

  /** Records one request against `key` and says whether it is allowed. */
  hit(key: string, now: number = Date.now()): RateLimitVerdict {
    this.sweepExpired(now);

    let window = this.windows.get(key);
    if (!window || now >= window.resetAt) {
      // Delete before re-inserting rather than mutating in place: Map iteration
      // follows insertion order, and eviction leans on that order meaning
      // "least recently active".
      this.windows.delete(key);
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }

    // After the insert, so the ceiling is a real ceiling. The key just added is
    // the newest and so the last thing eviction would reach for.
    this.trimToCapacity();

    // Stop counting once over the limit. The verdict is the same either way, and
    // a caller who keeps hammering shouldn't grow a number without bound.
    if (window.count <= this.limit) window.count++;

    const allowed = window.count <= this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - window.count),
      // Round up: a client told to wait 58 when 58.5s remain comes back early
      // and gets refused again for no reason it can see.
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      resetAt: window.resetAt,
    };
  }

  reset(): void {
    this.windows.clear();
    this.sweepAfter = 0;
  }

  /**
   * Drops windows that have already reset, so idle callers cost nothing.
   *
   * Lazy, on the next request after a window's worth of time, rather than on a
   * `setInterval` — a timer would hold the event loop open and have to be
   * unref'd and torn down on shutdown for no benefit at this scale.
   */
  private sweepExpired(now: number): void {
    if (now < this.sweepAfter) return;

    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
    this.sweepAfter = now + this.windowMs;
  }

  /**
   * A hard ceiling for the case the sweep can't help with: a flood of distinct
   * addresses inside one window. Insertion order is oldest window first, so this
   * sheds the least recently active callers.
   */
  private trimToCapacity(): void {
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}

/** Collapses the several ways of writing one address into a single bucket key. */
export function normaliseAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return 'unknown';

  // ::ffff:203.0.113.7 and 203.0.113.7 are the same caller reaching us over a
  // different stack; without this they would get a budget each.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

/**
 * The address a request should be charged to.
 *
 * `app.set('trust proxy', 1)` is what makes `req.ip` the address Coolify's proxy
 * saw rather than the proxy's own. Without it every request in production shares
 * one bucket, and the first busy household locks out everybody else.
 */
export function clientAddress(req: Request): string {
  return normaliseAddress(req.ip ?? req.socket?.remoteAddress ?? '');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for verbs that only read — used to limit writes without touching reads. */
export function isSafeMethod(req: Request): boolean {
  return SAFE_METHODS.has(req.method.toUpperCase());
}

export interface RateLimitOptions extends FixedWindowOptions {
  /** Shown to whoever tripped it, so write it for a person. */
  message: string;
  /** What to charge the request to. Defaults to the client address. */
  keyFor?: (req: Request) => string;
  /** Requests this returns true for pass through uncounted. */
  skip?: (req: Request) => boolean;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface RateLimiter extends RequestHandler {
  /** The counter behind it — exposed so tests can start from a clean slate. */
  readonly counter: FixedWindowCounter;
}

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const counter = new FixedWindowCounter(options);
  const keyFor = options.keyFor ?? clientAddress;
  const skip = options.skip;
  const clock = options.now ?? Date.now;

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (skip?.(req)) {
      next();
      return;
    }

    const now = clock();
    const verdict = counter.hit(keyFor(req), now);

    res.setHeader('RateLimit-Limit', String(counter.limit));
    res.setHeader('RateLimit-Remaining', String(verdict.remaining));
    res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((verdict.resetAt - now) / 1000))));

    if (verdict.allowed) {
      next();
      return;
    }

    // Delta-seconds rather than an HTTP-date: the client's clock is not to be
    // trusted, which is the same reason period keys are computed server-side.
    res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    // Answered here rather than through `next(new HttpError(...))` so this module
    // stays free of app imports. The shape is errorHandler's on purpose — the
    // client already understands `{ error, code }` and needs no special case.
    res.status(429).json({ error: options.message, code: 'rate_limited' });
  };

  return Object.assign(middleware, { counter });
}
