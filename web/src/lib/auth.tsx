import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import type { Me } from '@tally/shared';
import { api, setTokenSource } from './api';
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
      // The first authenticated call is what creates the row on our side, so
      // this doubles as registration.
      api
        .me()
        .then(setMe)
        .catch((cause: Error) => setError(cause.message))
        .finally(() => setLoading(false));
    });
  }, []);

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
