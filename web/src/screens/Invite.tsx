import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { InvitePreview } from '@tally/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { cadenceLabel } from '../lib/format';
import { SignIn } from './SignIn';
import { Avatar, ListSkeleton } from '../components/ui';

const CLOCK = (
  <svg width={52} height={52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-muted">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.5l3.5 2" />
  </svg>
);

const BLOCKED = (
  <svg width={52} height={52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" className="text-muted">
    <circle cx="12" cy="12" r="9" />
    <path d="M5.7 5.7l12.6 12.6" />
  </svg>
);

const TICK = (
  <svg width={52} height={52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="text-accent-ink">
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.8 2.8 5.2-6" />
  </svg>
);

/**
 * What someone sees when they open an invite link. Signed out, they sign in
 * first and land straight back here — the token is in the URL, so it survives
 * the round trip without needing to be stashed anywhere.
 */
export function Invite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { me, loading, signOut } = useAuth();
  const { refreshLists } = useData();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .invitePreview(token)
      .then(setPreview)
      .catch(() => setPreview({ status: 'not_found' }));
  }, [token]);

  useEffect(load, [load, me]);

  const join = async () => {
    setJoining(true);
    setError(null);
    try {
      const { listId } = await api.acceptInvite(token);
      await refreshLists();
      navigate(`/l/${listId}`, { replace: true });
    } catch (cause) {
      setError((cause as Error).message);
      load();
    } finally {
      setJoining(false);
    }
  };

  if (loading || !preview) return <ListSkeleton />;

  // Not signed in yet: show the sign-in screen with the invite as its reason.
  if (!me && preview.status !== 'not_found') {
    return (
      <SignIn
        intro={
          preview.list
            ? `${preview.inviterName} invited you to ${preview.list.emoji} ${preview.list.name}. Sign in and you'll join automatically.`
            : undefined
        }
      />
    );
  }

  const closed = preview.status !== 'ok';

  return (
    <div className="safe-top mx-auto flex h-full w-full max-w-md flex-col px-6 pb-[calc(env(safe-area-inset-bottom)+24px)]">
      <div className="flex min-h-[340px] flex-1 flex-col items-center justify-center text-center">
        {preview.status === 'ok' && preview.list && (
          <>
            <span className="mb-4 flex size-16 items-center justify-center rounded-full bg-tint text-2xl font-semibold text-accent-ink">
              <Avatar user={{ displayName: preview.inviterName ?? '?', photoUrl: null }} size={64} />
            </span>
            <div className="text-[22px] leading-tight font-semibold tracking-tight">
              {preview.inviterName} invited you to
              <br />
              {preview.list.emoji} {preview.list.name}
            </div>
            <p className="mt-3 text-sm text-muted">
              {preview.list.taskCount} task{preview.list.taskCount === 1 ? '' : 's'} ·{' '}
              {preview.list.memberCount} member{preview.list.memberCount === 1 ? '' : 's'} ·{' '}
              {cadenceLabel(preview.list).toLowerCase()}
            </p>
            <p className="mt-1.5 text-[13px] text-muted">
              You&apos;d join as a <span className="font-medium text-accent-ink">{preview.role}</span> —{' '}
              {preview.role === 'editor' ? 'you can tick tasks off and change them.' : 'you can tick tasks off.'}
            </p>
          </>
        )}

        {preview.status === 'already_member' && (
          <>
            {TICK}
            <div className="mt-4 text-xl font-semibold">
              You&apos;re already in {preview.list?.name ?? 'this list'}
            </div>
            <p className="mt-2.5 text-sm text-muted">Nothing to join — you&apos;re all set.</p>
          </>
        )}

        {preview.status === 'expired' && (
          <>
            {CLOCK}
            <div className="mt-4 text-xl font-semibold">This invite has expired</div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted text-pretty">
              Invite links last 7 days by default. Ask {preview.inviterName ?? 'the owner'} to send a fresh one.
            </p>
          </>
        )}

        {preview.status === 'revoked' && (
          <>
            {BLOCKED}
            <div className="mt-4 text-xl font-semibold">This invite was turned off</div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted text-pretty">
              The link was revoked by the list owner. Ask {preview.inviterName ?? 'them'} for a new one if
              this seems wrong.
            </p>
          </>
        )}

        {preview.status === 'used_up' && (
          <>
            {BLOCKED}
            <div className="mt-4 text-xl font-semibold">This invite has been used</div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted text-pretty">
              It was set to work a limited number of times. Ask for another link.
            </p>
          </>
        )}

        {preview.status === 'not_found' && (
          <>
            {BLOCKED}
            <div className="mt-4 text-xl font-semibold">We don&apos;t recognise that link</div>
            <p className="mt-2.5 text-sm leading-relaxed text-muted text-pretty">
              Check you copied all of it — invite links are long and easy to cut short.
            </p>
          </>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2.5">
        {error && (
          <p role="alert" className="text-center text-sm text-danger">
            {error}
          </p>
        )}

        {preview.status === 'ok' ? (
          <>
            <button type="button" onClick={() => void join()} disabled={joining} className="btn btn-primary">
              {joining ? 'Joining…' : `Join ${preview.list?.name ?? 'this list'}`}
            </button>
            <p className="text-center text-xs text-muted">
              Signed in as {me?.email ?? me?.displayName} ·{' '}
              <button type="button" onClick={() => void signOut()} className="underline underline-offset-2">
                not you?
              </button>
            </p>
          </>
        ) : (
          <button type="button" onClick={() => navigate('/')} className="btn btn-plain">
            {closed && preview.status === 'already_member' ? 'Open my lists' : 'Go to my lists'}
          </button>
        )}
      </div>
    </div>
  );
}
