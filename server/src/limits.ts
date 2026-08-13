import { config } from './config.js';
import { clientAddress, isSafeMethod, rateLimit, type RateLimiter } from './rate-limit.js';

/**
 * The app's rate limiters, in one place so it is obvious what is guarded and
 * what isn't. The mechanism lives in rate-limit.ts; this file is only the
 * tuning and the reasoning behind it.
 *
 * Not guarded, deliberately:
 *   - `GET /api/health`, which Coolify polls every 15s and which must never be
 *     refused — a 429 there would take the container out of rotation.
 *   - `GET /api/stream`, one long-lived SSE connection per device rather than a
 *     stream of requests, so there is nothing to count.
 *   - Reads on authenticated routes. They are already behind a Firebase token
 *     and a membership check, and limiting them would punish the person who
 *     switches lists quickly.
 */

const A_MINUTE = 60_000;

/**
 * The one unlocked door: `GET /api/invites/token/:token` and its accept, which
 * a signed-out person opens straight from a link.
 *
 * The token is 16 random bytes so guessing it is not realistic, but answering
 * every guess at full speed is still a free database query per attempt. Keyed on
 * the client address because there is no account to key on yet.
 */
export const inviteLookupLimiter: RateLimiter = rateLimit({
  limit: config.rateLimit.inviteLookupsPerMinute,
  windowMs: A_MINUTE,
  message: 'Too many invite links tried from here. Wait a minute and try again.',
});

/**
 * A backstop on authenticated writes.
 *
 * Keyed on the **signed-in person**, not the address: a household is one address
 * and four phones, and charging them all to one bucket would mean the busiest
 * evening of the week looks like an attack. Falls back to the address if this
 * ever runs somewhere unauthenticated, so the key can never be empty.
 *
 * Reads skip it entirely — this exists to bound writes.
 */
export const writeLimiter: RateLimiter = rateLimit({
  limit: config.rateLimit.writesPerMinute,
  windowMs: A_MINUTE,
  skip: isSafeMethod,
  keyFor: (req) => (req.user ? `user:${req.user.id}` : `ip:${clientAddress(req)}`),
  message: 'That is a lot of changes at once. Give it a moment and try again.',
});
