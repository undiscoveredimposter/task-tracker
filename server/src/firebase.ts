import { cert, getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config, isProduction } from './config.js';

export interface VerifiedToken {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

/**
 * Local development without a Firebase project. Double-gated: it needs an
 * explicit opt-in *and* a non-production NODE_ENV, and the deployed image sets
 * NODE_ENV=production, so it cannot switch itself on in a real deployment.
 */
const devAuthEnabled = !isProduction && process.env.TALLY_DEV_AUTH === '1';

let initialised = false;

function ensureApp(): void {
  if (initialised || getApps().length > 0) {
    initialised = true;
    return;
  }

  const { projectId, clientEmail, privateKey } = config.firebase;
  if (projectId && clientEmail && privateKey) {
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS / workload identity.
    initializeApp({ credential: applicationDefault() });
  }
  initialised = true;
}

export function reportAuthMode(): void {
  if (devAuthEnabled) {
    console.warn(
      '[auth] TALLY_DEV_AUTH is on — any "Bearer dev:<uid>:<email>" token is accepted. ' +
        'Never set this outside local development.',
    );
    return;
  }
  const { projectId } = config.firebase;
  console.log(`[auth] verifying Firebase ID tokens${projectId ? ` for project ${projectId}` : ''}`);
}

export async function verifyIdToken(idToken: string): Promise<VerifiedToken> {
  if (devAuthEnabled && idToken.startsWith('dev:')) {
    const [, uid, email] = idToken.split(':');
    if (!uid) throw new Error('dev token needs the form dev:<uid>:<email>');
    return { uid, email: email ?? `${uid}@example.test`, name: uid, picture: null };
  }

  ensureApp();
  const decoded = await getAuth().verifyIdToken(idToken);
  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    name: (decoded.name as string | undefined) ?? null,
    picture: (decoded.picture as string | undefined) ?? null,
  };
}

/**
 * Removes the Firebase identity behind a profile the person has just deleted,
 * so signing back in creates a fresh account rather than resurrecting the old
 * identity against a row that no longer exists.
 *
 * Best effort, and deliberately so: the database row is already gone by the time
 * this runs, and failing the request would tell somebody their account was still
 * there when it isn't. Returns whether it worked, for the caller's log line —
 * never the uid, which has no business in a log next to the word "deleted".
 */
export async function deleteAuthUser(uid: string): Promise<boolean> {
  // Dev auth invents identities locally; there is no Firebase project behind
  // them, and calling one would only ever be an error to swallow.
  if (devAuthEnabled) return false;

  try {
    ensureApp();
    await getAuth().deleteUser(uid);
    return true;
  } catch (error) {
    console.warn('[auth] could not delete the Firebase user behind a deleted profile', error);
    return false;
  }
}
