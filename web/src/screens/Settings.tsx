import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { DISPLAY_NAME_MAX, draftName, ownedListsWarning } from '../lib/profile';
import { ThemeToggle } from '../components/ThemeToggle';
import { Avatar, ScreenHeader, Sheet } from '../components/ui';

/**
 * Everything about you rather than about a list: what you are called, which
 * skin the app wears, and the two ways of leaving.
 *
 * It lives behind the avatar because that is where people look for an account,
 * and because the avatar used to sign you out on a single tap in the corner of
 * the home screen — a destructive action with no confirmation, in the place a
 * thumb lands by accident.
 */
export function Settings() {
  const { me, refresh, signOut } = useAuth();
  const { lists } = useData();
  const navigate = useNavigate();

  const [typed, setTyped] = useState(me?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Only ever reached through Protected, which renders no child until there is
  // a profile to render it with.
  if (!me) return null;

  const draft = draftName(typed, me.displayName);
  const owned = ownedListsWarning(lists);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateMe({ displayName: draft.name });
      // The auth provider owns `me`; the avatar here, the members list on every
      // shared list and the copy cached on this device all read it from there.
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /* Both of these leave the screen before they clear the session: signing out
     unmounts this component, and there is nothing here to come back to. */

  const leave = async () => {
    navigate('/', { replace: true });
    await signOut();
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteMe();
    } catch (cause) {
      setDeleteError((cause as Error).message);
      setDeleting(false);
      return;
    }
    navigate('/', { replace: true });
    await signOut();
  };

  return (
    <div className="safe-top h-full overflow-y-auto px-5 pb-12">
      <ScreenHeader title="Your account" back="/" />

      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3.5">
          <Avatar user={me} size={52} />
          <div className="min-w-0">
            <div className="truncate text-lg font-semibold">{me.displayName}</div>
            {me.email && <div className="truncate text-xs text-muted">{me.email}</div>}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="display-name">
            Short name
          </label>
          <input
            id="display-name"
            className="field"
            value={typed}
            maxLength={DISPLAY_NAME_MAX}
            onChange={(event) => setTyped(event.target.value)}
          />
          <p className="text-xs leading-snug text-muted text-pretty">
            What the others see beside a task you&apos;ve ticked off. Everyone on your lists sees the
            change.
          </p>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={() => void save()}
            disabled={!draft.savable || saving}
            className="btn btn-primary mt-1"
          >
            {saving ? 'Saving…' : draft.savable ? 'Save name' : 'Saved'}
          </button>
        </div>

        <ThemeToggle />

        <button type="button" onClick={() => void leave()} className="btn btn-plain">
          Sign out
        </button>

        <div className="flex flex-col gap-2 border-t border-divider pt-5">
          <span className="text-xs font-medium text-danger">Danger zone</span>
          <button
            type="button"
            onClick={() => {
              setDeleteError(null);
              setConfirming(true);
            }}
            className="btn border border-danger text-[15px] text-danger"
          >
            Delete your profile
          </button>
          <p className="text-xs leading-snug text-muted text-pretty">
            Your name and your place on every shared list go
            {owned ? ', and so do the lists you own' : ''}. This can&apos;t be undone.
          </p>
        </div>
      </div>

      {confirming && (
        <Sheet title="Delete your profile?" onClose={() => setConfirming(false)}>
          <div className="flex flex-col gap-3">
            <p className="text-[15px] leading-relaxed text-pretty">
              Your account goes for good.{owned ? ` ${owned}` : ''}
            </p>
            <p className="text-sm leading-relaxed text-muted text-pretty">
              Lists you only joined stay where they are — you simply come off them. Ticks you have
              already made stay in their history, without your name on them.
            </p>

            {deleteError && (
              <p role="alert" className="text-sm text-danger">
                {deleteError}
              </p>
            )}

            <button
              type="button"
              onClick={() => void remove()}
              disabled={deleting}
              className="btn border border-danger text-[15px] text-danger"
            >
              {deleting ? 'Deleting…' : 'Yes, delete my profile'}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="tap text-sm font-medium text-muted"
            >
              Keep it
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}
