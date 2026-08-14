import type { Request } from 'express';
import { HttpError, notFound } from './errors.js';
import { isUuid } from './ids.js';

/**
 * Reads a route parameter as a string.
 *
 * Express 5 types `req.params` as `string | string[] | undefined` on routers
 * mounted with `mergeParams`, so every call site would otherwise need the same
 * narrowing. A missing parameter means the route was mounted wrong, but a 400
 * beats a crash.
 */
export function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== 'string' || single.length === 0) {
    throw new HttpError(400, `Missing ${name} in the request path`);
  }
  return single;
}

/**
 * Reads a route parameter that is about to be used as a `uuid` in SQL.
 *
 * A value Postgres can't parse is a 404, not the 500 the driver's error would
 * otherwise become. `what` should name the thing the way the handler's own
 * `notFound()` does, so the answer is byte-identical to the one a well-formed
 * id matching nothing produces — a caller must not be able to tell "we can't
 * read that", "there is no such row" and "that row isn't yours" apart.
 *
 * The offending value is never repeated in the message: it is attacker-supplied
 * and has no business coming back out.
 */
export function uuidParam(req: Request, name: string, what?: string): string {
  const value = param(req, name);
  if (!isUuid(value)) throw notFound(what);
  return value;
}
