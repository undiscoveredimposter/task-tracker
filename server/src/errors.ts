import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { isProduction } from './config.js';

/**
 * An error whose message is safe to show a user. Anything else becomes a
 * generic 500 — internal detail never reaches the client in production.
 */
export class HttpError extends Error {
  // Written out rather than declared as constructor parameter properties: those
  // are the one piece of TypeScript that Node's built-in type stripping cannot
  // erase, and the integration tests load these modules straight from source.
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'That') => new HttpError(404, `${what} could not be found`);
export const forbidden = (message = "You don't have permission to do that") =>
  new HttpError(403, message);

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    const first = error.issues[0];
    res.status(400).json({
      error: first ? `${first.path.join('.') || 'Request'}: ${first.message}` : 'Invalid request',
      code: 'invalid_request',
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }

  console.error('[error]', error);
  res.status(500).json({
    error: isProduction ? 'Something went wrong' : String((error as Error)?.message ?? error),
    code: 'internal',
  });
}
