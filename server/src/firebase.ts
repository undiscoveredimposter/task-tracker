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
