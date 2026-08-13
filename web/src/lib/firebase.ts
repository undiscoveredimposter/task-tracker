import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
} from 'firebase/auth';

/**
 * Vite inlines VITE_* at BUILD time, not runtime, so these must be set as build
 * variables in Coolify. Set them only as runtime env and the app ships with
 * undefined config — see docs/DEPLOY.md.
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseConfigured = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

export function auth(): Auth {
  if (!firebaseConfigured) {
    throw new Error(
      'Firebase is not configured. Set VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, ' +
        'VITE_FIREBASE_PROJECT_ID and VITE_FIREBASE_APP_ID as build variables.',
    );
  }
  if (!authInstance) {
    app = app ?? initializeApp(firebaseConfig);
    authInstance = getAuth(app);
    // Keep people signed in — a household checklist that logs you out is a
    // household checklist nobody opens.
    void setPersistence(authInstance, browserLocalPersistence);
  }
  return authInstance;
}

export async function signInWithGoogle(): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth(), provider);
  } catch (error) {
    // Installed PWAs and some in-app browsers block popups outright; the
    // redirect flow is the fallback that works everywhere.
    const code = (error as { code?: string }).code ?? '';
    if (code.includes('popup')) {
      await signInWithRedirect(auth(), provider);
      return;
    }
    throw error;
  }
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth(), email, password);
}

export async function registerWithPassword(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(auth(), email, password);
}

const EMAIL_KEY = 'tally.magicLinkEmail';

/**
 * Sends a sign-in link. Firebase delivers this itself, so Tally needs no email
 * provider of its own — the trade-off is that it arrives from a firebaseapp.com
 * address unless a custom domain is configured.
 */
export async function sendMagicLink(email: string): Promise<void> {
  await sendSignInLinkToEmail(auth(), email, {
    url: `${window.location.origin}${window.location.pathname}${window.location.search}`,
    handleCodeInApp: true,
  });
  // The link may be opened in a different tab, so remember who asked for it.
  window.localStorage.setItem(EMAIL_KEY, email);
}

export function isMagicLink(url: string): boolean {
  return firebaseConfigured && isSignInWithEmailLink(auth(), url);
}

export async function completeMagicLink(url: string, fallbackEmail?: string): Promise<void> {
  const email = window.localStorage.getItem(EMAIL_KEY) ?? fallbackEmail;
  if (!email) throw new Error('Enter the email address the link was sent to');
  await signInWithEmailLink(auth(), email, url);
  window.localStorage.removeItem(EMAIL_KEY);
}

export async function signOutOfTally(): Promise<void> {
  await signOut(auth());
}
