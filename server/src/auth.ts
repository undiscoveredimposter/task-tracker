import type { NextFunction, Request, Response } from 'express';
import { queryOne } from './db.js';
import { verifyIdToken } from './firebase.js';
import { HttpError } from './errors.js';
import { providerDisplayName } from './profile.js';

export interface AuthedUser {
  id: string;
  firebaseUid: string;
  email: string | null;
  displayName: string;
  photoUrl: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/**
 * Verifies the Firebase ID token and reflects the identity into `users`. There
 * is no separate registration step — first authenticated request creates the row.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'Sign in to continue');

    let verified;
    try {
      verified = await verifyIdToken(token);
    } catch {
      throw new HttpError(401, 'Your session has expired — sign in again');
    }

    const displayName = providerDisplayName(verified.name, verified.email);
    const user = await queryOne<{
      id: string;
      firebase_uid: string;
      email: string | null;
      display_name: string;
      photo_url: string | null;
    }>(
      `INSERT INTO users (firebase_uid, email, display_name, photo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (firebase_uid) DO UPDATE
         SET email        = EXCLUDED.email,
             photo_url    = EXCLUDED.photo_url,
             -- This runs on every authenticated request, so it is the thing most
             -- likely to undo a rename. A name someone chose for themselves wins
             -- outright; otherwise take the provider's, keeping what we already
             -- have if the provider has stopped sending one.
             display_name = CASE
                              WHEN users.display_name_custom THEN users.display_name
                              ELSE COALESCE(NULLIF(EXCLUDED.display_name, ''), users.display_name)
                            END,
             last_seen_at = now()
       RETURNING id, firebase_uid, email, display_name, photo_url`,
      [verified.uid, verified.email?.toLowerCase() ?? null, displayName, verified.picture],
    );

    if (!user) throw new HttpError(500, 'Could not load your account');

    req.user = {
      id: user.id,
      firebaseUid: user.firebase_uid,
      email: user.email,
      displayName: user.display_name,
      photoUrl: user.photo_url,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Attaches the user when a valid token is present and shrugs when it isn't.
 * Used by the invite preview, which a signed-out person opens from a link but
 * which says something more useful once we know who they are.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!bearer(req)) {
    next();
    return;
  }
  await requireAuth(req, res, (error?: unknown) => next(error instanceof Error ? undefined : error));
}

/** Narrowing helper for handlers mounted behind `requireAuth`. */
export function authed(req: Request): AuthedUser {
  if (!req.user) throw new HttpError(401, 'Sign in to continue');
  return req.user;
}
