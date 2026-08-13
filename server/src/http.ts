import type { Request } from 'express';
import { HttpError } from './errors.js';

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
