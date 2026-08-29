import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Invite, InvitePreview, InviteStatus } from '@tally/shared';
import { authed, optionalAuth, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcastSpace } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import { requireSpaceAccess } from '../spaces.js';
import { param, uuidParam } from '../http.js';
import { inviteStatusOf } from '../invite-policy.js';
import { inviteLookupLimiter, writeLimiter } from '../limits.js';

export const inviteRouter: Router = Router();
export const spaceInviteRouter: Router = Router({ mergeParams: true });

/**
 * 16 random bytes, base64url. Invite links let anyone holding them join, so the
 * token has to be genuinely unguessable — the short codes in the mockup are for
 * illustration, not something to ship.
 */
function newToken(): string {
  return randomBytes(16).toString('base64url');
}

const inviteUrl = (token: string) => `${config.appOrigin}/j/${token}`;

interface InviteRow {
  id: string;
  space_id: string;
  token: string;
  role: 'editor' | 'viewer';
  created_at: Date;
  expires_at: Date | null;
  max_uses: number | null;
  use_count: number;
  revoked_at: Date | null;
}

function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    role: row.role,
    token: row.token,
    url: inviteUrl(row.token),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    maxUses: row.max_uses,
    useCount: row.use_count,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

/** Why a link won't work, or `ok`. The rules themselves live in invite-policy.ts. */
function inviteStatus(row: InviteRow): InviteStatus {
  return inviteStatusOf({
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
  });
}

/* ── Owner-facing: /api/spaces/:id/invites ───────────────────────────────── */

const createInviteSchema = z.object({
  role: z.enum(['editor', 'viewer']),
  expiresInDays: z.number().int().min(1).max(365).nullish(),
  maxUses: z.number().int().min(1).max(100).nullish(),
});

spaceInviteRouter.use(requireAuth, writeLimiter);

spaceInviteRouter.get('/', async (req, res) => {
  const user = authed(req);
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id, 'owner');

  const rows = await query<InviteRow>(
    `SELECT * FROM invites
      WHERE space_id = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC`,
    [space.id],
  );
  res.json(rows.map(toInvite));
});

spaceInviteRouter.post('/', async (req, res) => {
  const user = authed(req);
  // Sharing stays with the owner — editors can change tasks, not membership.
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id, 'owner');
  const body = createInviteSchema.parse(req.body);

  const days = body.expiresInDays === undefined ? config.inviteDefaultDays : body.expiresInDays;

  const row = await queryOne<InviteRow>(
    `INSERT INTO invites (space_id, token, role, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL OR $5::int <= 0 THEN NULL
                  ELSE now() + ($5::int * INTERVAL '1 day') END,
             $6)
     RETURNING *`,
    [space.id, newToken(), body.role, user.id, days ?? null, body.maxUses ?? null],
  );
  if (!row) throw new HttpError(500, 'Could not create that invite');

  res.status(201).json(toInvite(row));
});

/* ── Owner-facing: /api/invites/:id ──────────────────────────────────────── */

inviteRouter.delete('/:id', requireAuth, writeLimiter, async (req, res) => {
  const user = authed(req);
  const row = await queryOne<InviteRow>('SELECT * FROM invites WHERE id = $1', [
    uuidParam(req, 'id', 'That invite'),
  ]);
  if (!row) throw notFound('That invite');

  await requireSpaceAccess(row.space_id, user.id, 'owner');
  await query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.id]);
  res.status(204).end();
});

/* ── Invitee-facing: /api/invites/:token ─────────────────────────────────── */

/**
 * `param`, not `uuidParam`: a token is 16 random bytes in base64url, not a uuid,
 * and `invites.token` is text — an unparseable one selects nothing rather than
 * raising, so an unknown link still previews as `not_found`.
 */
async function loadByToken(token: string): Promise<InviteRow | null> {
  return queryOne<InviteRow>('SELECT * FROM invites WHERE token = $1', [token]);
}

// The limiter runs before `optionalAuth` on both token routes, so a flood is
// refused before it costs a token verification or a database round trip.
inviteRouter.get('/token/:token', inviteLookupLimiter, optionalAuth, async (req, res) => {
  const row = await loadByToken(param(req, 'token'));
  if (!row) {
    res.json({ status: 'not_found' } satisfies InvitePreview);
    return;
  }

  let status = inviteStatus(row);

  if (req.user && status === 'ok') {
    const existing = await queryOne(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [row.space_id, req.user.id],
    );
    if (existing) status = 'already_member';
  }

  // What the link is actually offering: a space, and everything in it. The
  // count is of lists anyone in the space can see — a private one is nobody's
  // business but its owner's, and would be a strange thing to advertise to
  // somebody who has not joined yet.
  const space = await queryOne<{
    name: string;
    emoji: string;
    list_count: number;
    member_count: number;
    inviter: string | null;
  }>(
    `SELECT s.name, s.emoji,
            (SELECT count(*) FROM lists l
              WHERE l.space_id = s.id AND l.archived_at IS NULL AND NOT l.private) AS list_count,
            (SELECT count(*) FROM space_members m WHERE m.space_id = s.id) AS member_count,
            (SELECT u.display_name FROM users u WHERE u.id = s.owner_id) AS inviter
       FROM spaces s WHERE s.id = $1`,
    [row.space_id],
  );

  if (!space) {
    res.json({ status: 'not_found' } satisfies InvitePreview);
    return;
  }

  const preview: InvitePreview = {
    status,
    role: row.role,
    inviterName: space.inviter ?? 'Someone',
    space: {
      name: space.name,
      emoji: space.emoji,
      listCount: space.list_count,
      memberCount: space.member_count,
    },
  };
  res.json(preview);
});

inviteRouter.post('/token/:token/accept', inviteLookupLimiter, requireAuth, async (req, res) => {
  const user = authed(req);
  const row = await loadByToken(param(req, 'token'));
  if (!row) throw notFound('That invite');

  const spaceId = await transaction(async (client) => {
    // Re-read under a row lock: two people opening the same single-use link at
    // the same moment must not both get past the use_count check.
    const locked = await client.query<InviteRow>('SELECT * FROM invites WHERE id = $1 FOR UPDATE', [
      row.id,
    ]);
    const invite = locked.rows[0];
    if (!invite) throw notFound('That invite');

    const existing = await client.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [invite.space_id, user.id],
    );
    if (existing.rowCount) return invite.space_id; // Already in — accepting again is a no-op.

    const status = inviteStatus(invite);
    if (status !== 'ok') {
      throw new HttpError(
        410,
        status === 'revoked'
          ? 'That invite was turned off by the list owner'
          : status === 'expired'
            ? 'That invite has expired — ask for a fresh link'
            : 'That invite has already been used',
        status,
      );
    }

    await client.query('INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, $3)', [
      invite.space_id,
      user.id,
      invite.role,
    ]);
    await client.query('UPDATE invites SET use_count = use_count + 1 WHERE id = $1', [invite.id]);
    return invite.space_id;
  });

  await broadcastSpace(spaceId, { type: 'space.changed', spaceId }, user.id);
  res.json({ spaceId });
});
