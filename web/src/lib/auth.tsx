import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import type { Me } from '@tally/shared';
import { OfflineError, api, setTokenSource } from './api';
import { readCache } from './cache';
import { auth, firebaseConfigured, signOutOfTally } from './firebase';

interface AuthState {
  /** Null until Firebase has told us whether anyone is signed in. */
  loading: boolean;
  firebaseUser: User | null;
  me: Me | null;
  error: string | null;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!firebaseConfigured) {
      setError('Firebase is not configured for this build.');
      setLoading(false);
      return;
    }

    // getIdToken() refreshes on its own when the hour-long token is close to
    // expiring, so every request gets a live one without us tracking clocks.
    setTokenSource(async () => (auth().currentUser ? auth().currentUser!.getIdToken() : null));

    return onAuthStateChanged(auth(), (user) => {
      setFirebaseUser(user);
      if (!user) {
        setMe(null);
        setLoading(false);
        return;
      }
      // Firebase restores a session without a network, so an offline launch
      // gets this far and then can't ask who the user is. The remembered
      // profile stands in until it can.
      const remembered = readCache.read(user.uid)?.me ?? null;
      if (remembered) setMe(remembered);

      // The first authenticated call is what creates the row on our side, so
      // this doubles as registration.
      api
        .me()
        .then(setMe)
        .catch((cause: Error) => {
          if (cause instanceof OfflineError && remembered) return;
          setError(cause.message);
        })
        .finally(() => setLoading(false));
    });
  }, []);

  /* Offline with nothing saved, the fetch above failed and there is no profile
     to render anything with. Firebase won't call back again — the session was
     already restored — so the return of the network is the only cue left. */
  useEffect(() => {
    if (me || !firebaseUser) return;

    const retry = () => {
      api
        .me()
        .then((profile) => {
          setMe(profile);
          setError(null);
        })
        .catch(() => undefined);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [me, firebaseUser]);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      firebaseUser,
      me,
      error,
      signOut: async () => {
        await signOutOfTally();
        setMe(null);
      },
      refresh: async () => {
        setMe(await api.me());
      },
    }),
    [loading, firebaseUser, me, error],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
