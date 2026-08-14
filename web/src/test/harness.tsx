import { useSyncExternalStore } from 'react';
import { act } from '@testing-library/react';
import type { Me } from '@tally/shared';
import type { User } from 'firebase/auth';

/**
 * The two things a provider's effects reach for that a test has to own: who is
 * signed in, and what the network says.
 *
 * Both are replaced at the module boundary rather than inside the provider, so
 * the code under test is the shipped code — the real `api`, the real cache, the
 * real effect ordering.
 */

/* ---------- who is signed in ---------- */

interface FakeAuthState {
  loading: boolean;
  firebaseUser: User | null;
  me: Me | null;
  error: string | null;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const signedOut: FakeAuthState = {
  loading: false,
  firebaseUser: null,
  me: null,
  error: null,
  signOut: async () => undefined,
  refresh: async () => undefined,
};

let authState: FakeAuthState = signedOut;
const listeners = new Set<() => void>();

function publish(next: FakeAuthState): void {
  // Wrapped so a test can sign someone in and look at the screen on the next
  // line, the way it can after `render`.
  act(() => {
    authState = next;
    for (const listener of listeners) listener();
  });
}

/**
 * Stands in for `useAuth`. A test file points the `./auth` module mock here.
 *
 * An external store rather than component state: `signIn` and `signOut` are
 * called from the test body, outside any component, which is what a Firebase
 * callback firing mid-session looks like from the provider's side.
 */
export function useFakeAuth(): FakeAuthState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => authState,
  );
}

/** Firebase's `User` is large and the provider reads one field of it. */
export function signIn(uid: string, me: Me): void {
  publish({ ...signedOut, firebaseUser: { uid } as unknown as User, me });
}

export function signOut(): void {
  publish(signedOut);
}

/* ---------- what the network says ---------- */

export interface FakeServer {
  /** Answers `GET /api<path>` straight away. */
  answer(path: string, body: unknown): void;
  /**
   * Registers a route that stays in flight until the returned function is
   * called — which is how a test gets to look at the screen during the wait.
   */
  hold(path: string): (body: unknown) => void;
  /** Every URL asked for, in order. */
  readonly asked: string[];
  restore(): void;
}

export function fakeServer(): FakeServer {
  const asked: string[] = [];
  const answers = new Map<string, () => Promise<unknown>>();
  const realFetch = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);

    const answer = answers.get(url);
    // An unregistered route is not a 404: the request never left the device,
    // which is the failure `api` reads as being offline.
    if (!answer) return Promise.reject(new TypeError('Failed to fetch'));

    return answer().then(
      (body) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }) as typeof fetch;

  return {
    asked,
    answer(path, body) {
      answers.set(`/api${path}`, () => Promise.resolve(body));
    },
    hold(path) {
      let release!: (body: unknown) => void;
      const inFlight = new Promise<unknown>((resolve) => {
        release = resolve;
      });
      answers.set(`/api${path}`, () => inFlight);
      return release;
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Runs everything already queued to completion, so a test can assert that
 * nothing changed. `waitFor` can only wait for something to become true; the
 * claim "the saved copy survived the failed request" needs the opposite. The
 * timeout crosses a macrotask boundary, which is what guarantees the pending
 * promise chains have finished rather than merely started.
 */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
