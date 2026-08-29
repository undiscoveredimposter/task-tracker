import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Invite, Role } from '@tally/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/store';
import { Avatar, ChevronIcon, LinkIcon, ListSkeleton, ScreenHeader } from '../components/ui';

/**
 * A space: what it is called, who is in it, and the link that lets someone in.
 *
 * Sharing happens here and only here. Handing someone a link puts them in the
 * space at the role on the link, which is their role on every list in it — so
 * this one screen is the whole of "share this with the household", and the
 * lists themselves have nothing to share.
 */

type InviteRole = Exclude<Role, 'owner'>;

function expiryLabel(invite: Invite): string {
  if (!invite.expiresAt) return 'never expires';
  const days = Math.ceil((new Date(invite.expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'expired';
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function Space() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const { getSpace, refreshLists } = useData();
  const navigate = useNavigate();
  const space = getSpace(id);
  const isOwner = space?.role === 'owner';

  const [role, setRole] = useState<InviteRole>('viewer');
  const [invites, setInvites] = useState<Invite[]>([]);
  const [fresh, setFresh] = useState<Invite | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshLists();
  }, [id, refreshLists]);

  // Only an owner may read these, so asking as anybody else is a 403 the
  // console does not need to see.
  useEffect(() => {
    if (!isOwner) return;
    api
      .invites(id)
      .then(setInvites)
      .catch(() => setInvites([]));
  }, [id, isOwner]);

  if (!space) return <ListSkeleton />;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const invite = await api.createInvite(space.id, { role });
      setFresh(invite);
      setCopied(false);
      setInvites(await api.invites(space.id));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateSpace(space.id, { name: name.trim() });
      await refreshLists();
      setRenaming(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!me) return;
    setError(null);
    try {
      await api.removeMember(space.id, me.id);
      await refreshLists();
      navigate('/', { replace: true });
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const copy = async (url: string) => {
    try {
      // The Web Share sheet is the natural thing on a phone; the clipboard is
      // the fallback everywhere else.
      if (navigator.share) {
        await navigator.share({ title: `Join ${space.name} on Tally`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the link and copy it by hand.');
    }
  };

  const revoke = async (inviteId: string) => {
    await api.revokeInvite(inviteId);
    setInvites(await api.invites(space.id));
    if (fresh?.id === inviteId) setFresh(null);
  };

  const changeRole = async (userId: string, next: InviteRole) => {
    await api.setMemberRole(space.id, userId, next);
    await refreshLists();
  };

  const removeMember = async (userId: string) => {
    await api.removeMember(space.id, userId);
    await refreshLists();
  };

  return (
    <div className="safe-top h-full overflow-y-auto px-5 pb-12">
      <ScreenHeader title={`${space.emoji} ${space.name}`} back="/" />

      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-relaxed text-muted text-pretty">
            {space.listCount === 0
              ? 'Nothing in here yet.'
              : `${space.listCount} list${space.listCount === 1 ? '' : 's'} in here.`}{' '}
            Everyone in this space sees all of them, and anything added later.
          </p>

          {isOwner &&
            (renaming ? (
              <div className="flex gap-2">
                <input
                  aria-label="Space name"
                  autoFocus
                  maxLength={80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="field flex-1"
                />
                <button
                  type="button"
                  onClick={() => void rename()}
                  disabled={busy || !name.trim()}
                  className="btn shrink-0 border-[1.5px] border-accent px-4 text-accent-ink"
                >
                  Save
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setName(space.name);
                  setRenaming(true);
                }}
                className="tap self-start rounded-xl text-sm font-medium text-accent-ink"
              >
                Rename this space
              </button>
            ))}
        </div>

        {isOwner ? (
          <div className="flex flex-col gap-2.5">
            <span className="text-xs font-medium text-muted">Invite someone as</span>
            <div className="flex gap-2">
              {(
                [
                  ['viewer', 'Viewer', 'Can tick tasks off'],
                  ['editor', 'Editor', 'Can also add and delete tasks'],
                ] as [InviteRole, string, string][]
              ).map(([id_, label, hint]) => (
                <button
                  key={id_}
                  type="button"
                  onClick={() => setRole(id_)}
                  aria-pressed={role === id_}
                  className={`flex min-h-[68px] flex-1 flex-col items-start gap-0.5 rounded-2xl px-3.5 py-2.5 text-left ${
                    role === id_ ? 'border-[1.5px] border-accent bg-tint' : 'border border-control bg-surface'
                  }`}
                >
                  <span className="text-[15px] font-semibold">{label}</span>
                  <span className="text-xs leading-snug font-normal text-muted">{hint}</span>
                </button>
              ))}
            </div>

            {fresh ? (
              <div className="anim-fadein flex flex-col gap-2">
                <div className="flex gap-2">
                  <span className="flex min-h-13 flex-1 items-center overflow-hidden rounded-2xl border border-control bg-surface px-3.5 font-mono text-[13px] text-ellipsis whitespace-nowrap text-muted">
                    {fresh.url}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copy(fresh.url)}
                    className={`btn shrink-0 border-[1.5px] border-accent px-4 text-accent-ink ${copied ? 'bg-tint' : ''}`}
                  >
                    {copied ? 'Copied ✓' : 'Copy'}
                  </button>
                </div>
                <p className="text-xs leading-snug text-muted">
                  Anyone with this link can join as {fresh.role} · {expiryLabel(fresh)}
                </p>
              </div>
            ) : (
              <button type="button" onClick={() => void create()} disabled={busy} className="btn btn-primary">
                {busy ? 'Creating…' : 'Create invite link'}
              </button>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}

            <p className="text-xs leading-snug text-muted">
              Only you can invite people — editors can change tasks, not membership. Whoever joins
              gets this role on every list in the space.
            </p>
          </div>
        ) : (
          <p className="text-xs leading-snug text-muted">
            {space.members.find((member) => member.role === 'owner')?.displayName ?? 'The owner'}{' '}
            looks after who is in this space.
          </p>
        )}

        {isOwner && invites.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">Active invites</span>
            {invites.map((invite) => (
              <div key={invite.id} className="card flex min-h-15 items-center gap-3 rounded-2xl py-2 pr-2 pl-4">
                <LinkIcon />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium capitalize">{invite.role} link</div>
                  <div className="truncate text-xs text-muted">
                    {invite.useCount === 0 ? 'not used yet' : `used ${invite.useCount}×`} · {expiryLabel(invite)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revoke(invite.id)}
                  className="tap shrink-0 rounded-xl px-3.5 text-sm font-medium text-danger"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Members</span>
          {space.members.map((member, index) => (
            <div key={member.id} className="card flex min-h-15 items-center gap-3 rounded-2xl py-2 pr-2 pl-4">
              <Avatar user={member} index={index} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium">
                  {member.displayName}
                  {member.id === me?.id && <span className="text-xs font-normal text-muted"> (you)</span>}
                </div>
              </div>

              {member.role === 'owner' || !isOwner ? (
                <span className="shrink-0 pr-2 text-[13px] text-muted capitalize">{member.role}</span>
              ) : (
                <>
                  <div className="relative">
                    <select
                      aria-label={`Role for ${member.displayName}`}
                      value={member.role}
                      onChange={(event) => void changeRole(member.id, event.target.value as InviteRole)}
                      className="tap appearance-none rounded-xl bg-transparent py-0 pr-6 pl-2 text-[13px] text-muted"
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <span className="pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 text-muted">
                      <ChevronIcon size={12} />
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removeMember(member.id)}
                    aria-label={`Remove ${member.displayName}`}
                    className="flex size-11 shrink-0 items-center justify-center text-muted"
                  >
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {!isOwner && (
          <button
            type="button"
            onClick={() => void leave()}
            className="btn self-start border border-danger px-4 text-[15px] text-danger"
          >
            Leave this space
          </button>
        )}
      </div>
    </div>
  );
}
