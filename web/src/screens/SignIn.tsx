import { useEffect, useState, type FormEvent } from 'react';
import {
  completeMagicLink,
  isMagicLink,
  registerWithPassword,
  sendMagicLink,
  signInWithGoogle,
  signInWithPassword,
} from '../lib/firebase';
import { GoogleIcon, TallyMark } from '../components/ui';

type Mode = 'password' | 'link';

/** Firebase error codes, turned into something a person would say. */
function friendlyError(error: unknown): string {
  const code = (error as { code?: string })?.code ?? '';
  if (code.includes('invalid-credential') || code.includes('wrong-password')) {
    return 'That email and password do not match.';
  }
  if (code.includes('email-already-in-use')) return 'That email already has an account — sign in instead.';
  if (code.includes('weak-password')) return 'Pick a password of at least six characters.';
  if (code.includes('invalid-email')) return 'That does not look like an email address.';
  if (code.includes('too-many-requests')) return 'Too many tries. Wait a minute and have another go.';
  if (code.includes('network')) return 'No connection — check your signal and try again.';
  return (error as Error)?.message ?? 'Something went wrong.';
}

export function SignIn({ intro }: { intro?: string }) {
  const [mode, setMode] = useState<Mode>('password');
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);

  // Arriving back from a magic link: finish the sign-in without the person
  // having to do anything else.
  useEffect(() => {
    if (!isMagicLink(window.location.href)) return;
    setBusy(true);
    completeMagicLink(window.location.href)
      .catch((cause) => setError(friendlyError(cause)))
      .finally(() => setBusy(false));
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'link') {
      void run(async () => {
        await sendMagicLink(email);
        setLinkSent(true);
      });
      return;
    }
    void run(() => (creating ? registerWithPassword(email, password) : signInWithPassword(email, password)));
  };

  return (
    <div className="safe-top mx-auto flex min-h-full w-full max-w-md flex-col px-6">
      <div className="flex min-h-[300px] flex-1 flex-col justify-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-2xl border-[1.5px] border-accent">
          <TallyMark />
        </div>
        <h1 className="text-3xl leading-none font-semibold tracking-tight">Tally</h1>
        <p className="mt-2.5 text-base leading-relaxed text-muted text-pretty">
          {intro ?? "The shared checklist for the people you live with — tick it off once, everyone knows it's done."}
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex shrink-0 flex-col gap-3 pb-4">
        <button type="button" onClick={() => void run(signInWithGoogle)} disabled={busy} className="btn btn-plain">
          <GoogleIcon />
          Continue with Google
        </button>

        <div className="flex items-center gap-3 py-0.5">
          <span className="h-px flex-1 bg-divider" />
          <span className="text-xs text-muted">or with email</span>
          <span className="h-px flex-1 bg-divider" />
        </div>

        <input
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="field"
        />

        {mode === 'password' && (
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            required
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field"
          />
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        {linkSent ? (
          <p className="rounded-2xl bg-tint px-4 py-3 text-sm text-accent-ink">
            Check your email — the link signs you straight in. It can take a minute to arrive.
          </p>
        ) : (
          <button type="submit" disabled={busy} className="btn btn-primary">
            {busy ? 'One moment…' : mode === 'link' ? 'Email me a sign-in link' : creating ? 'Create account' : 'Sign in'}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'password' ? 'link' : 'password');
            setLinkSent(false);
            setError(null);
          }}
          className="tap text-sm font-medium text-accent-ink underline underline-offset-[3px]"
        >
          {mode === 'password' ? 'Email me a sign-in link instead' : 'Use a password instead'}
        </button>

        {mode === 'password' && (
          <button
            type="button"
            onClick={() => {
              setCreating(!creating);
              setError(null);
            }}
            className="tap text-sm text-muted"
          >
            {creating ? 'Already have an account? Sign in' : 'New here? Create an account'}
          </button>
        )}
      </form>
    </div>
  );
}
