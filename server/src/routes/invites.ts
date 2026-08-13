import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Invite, InvitePreview, InviteStatus } from '@tally/shared';
import { authed, optionalAuth, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcast } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import { requireListAccess } from '../lists.js';
import { param } from '../http.js';
import { inviteStatusOf } from '../invite-policy.js';

export const inviteRouter: Router = Router();
export const listInviteRouter: Router = Router({ mergeParams: true });

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
  list_id: string;
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

/* ── Owner-facing: /api/lists/:id/invites ────────────────────────────────── */

const createInviteSchema = z.object({
  role: z.enum(['editor', 'viewer']),
  expiresInDays: z.number().int().min(1).max(365).nullish(),
  maxUses: z.number().int().min(1).max(100).nullish(),
});

listInviteRouter.use(requireAuth);

listInviteRouter.get('/', async (req, res) => {
  const user = authed(req);
  const { list } = await requireListAccess(param(req, 'id'), user.id, 'owner');

  const rows = await query<InviteRow>(
    `SELECT * FROM invites
      WHERE list_id = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY created_at DESC`,
    [list.id],
  );
  res.json(rows.map(toInvite));
});

listInviteRouter.post('/', async (req, res) => {
  const user = authed(req);
  // Sharing stays with the owner — editors can change tasks, not membership.
  const { list } = await requireListAccess(param(req, 'id'), user.id, 'owner');
  const body = createInviteSchema.parse(req.body);

  const days = body.expiresInDays === undefined ? config.inviteDefaultDays : body.expiresInDays;

  const row = await queryOne<InviteRow>(
    `INSERT INTO invites (list_id, token, role, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4,
             CASE WHEN $5::int IS NULL OR $5::int <= 0 THEN NULL
                  ELSE now() + ($5::int * INTERVAL '1 day') END,
             $6)
     RETURNING *`,
    [list.id, newToken(), body.role, user.id, days ?? null, body.maxUses ?? null],
  );
  if (!row) throw new HttpError(500, 'Could not create that invite');

  res.status(201).json(toInvite(row));
});

/* ── Owner-facing: /api/invites/:id ──────────────────────────────────────── */

inviteRouter.delete('/:id', requireAuth, async (req, res) => {
  const user = authed(req);
  const row = await queryOne<InviteRow>('SELECT * FROM invites WHERE id = $1', [param(req, 'id')]);
  if (!row) throw notFound('That invite');

  await requireListAccess(row.list_id, user.id, 'owner');
  await query('UPDATE invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [row.id]);
  res.status(204).end();
});

/* ── Invitee-facing: /api/invites/:token ─────────────────────────────────── */

async function loadByToken(token: string): Promise<InviteRow | null> {
  return queryOne<InviteRow>('SELECT * FROM invites WHERE token = $1', [token]);
}

inviteRouter.get('/token/:token', optionalAuth, async (req, res) => {
  const row = await loadByToken(param(req, 'token'));
  if (!row) {
    res.json({ status: 'not_found' } satisfies InvitePreview);
    return;
  }

  let status = inviteStatus(row);

  if (req.user && status === 'ok') {
    const existing = await queryOne(
      'SELECT 1 FROM list_members WHERE list_id = $1 AND user_id = $2',
      [row.list_id, req.user.id],
    );
    if (existing) status = 'already_member';
  }

  const list = await queryOne<{
    name: string;
    emoji: string;
    timezone: string;
    reset_hour: number;
    cadence: 'daily' | 'weekly' | 'monthly' | 'every_n_days' | 'none';
    cadence_interval_days: number;
    week_start: 1 | 2 | 3 | 4 | 5 | 6 | 7;
    task_count: number;
    member_count: number;
    inviter: string | null;
  }>(
    `SELECT l.name, l.emoji, l.timezone, l.reset_hour, l.cadence,
            l.cadence_interval_days, l.week_start,
            (SELECT count(*) FROM tasks t WHERE t.list_id = l.id AND t.archived_at IS NULL) AS task_count,
            (SELECT count(*) FROM list_members m WHERE m.list_id = l.id) AS member_count,
            (SELECT u.display_name FROM users u WHERE u.id = l.owner_id) AS inviter
       FROM lists l WHERE l.id = $1 AND l.archived_at IS NULL`,
    [row.list_id],
  );

  if (!list) {
    res.json({ status: 'not_found' } satisfies InvitePreview);
    return;
  }

  const preview: InvitePreview = {
    status,
    role: row.role,
    inviterName: list.inviter ?? 'Someone',
    list: {
      name: list.name,
      emoji: list.emoji,
      taskCount: list.task_count,
      memberCount: list.member_count,
      cadence: list.cadence,
      cadenceIntervalDays: list.cadence_interval_days,
      weekStart: list.week_start,
      timezone: list.timezone,
      resetHour: list.reset_hour,
    },
  };
  res.json(preview);
});

inviteRouter.post('/token/:token/accept', requireAuth, async (req, res) => {
  const user = authed(req);
  const row = await loadByToken(param(req, 'token'));
  if (!row) throw notFound('That invite');

  const listId = await transaction(async (client) => {
    // Re-read under a row lock: two people opening the same single-use link at
    // the same moment must not both get past the use_count check.
    const locked = await client.query<InviteRow>('SELECT * FROM invites WHERE id = $1 FOR UPDATE', [
      row.id,
    ]);
    const invite = locked.rows[0];
    if (!invite) throw notFound('That invite');

    const existing = await client.query('SELECT 1 FROM list_members WHERE list_id = $1 AND user_id = $2', [
      invite.list_id,
      user.id,
    ]);
    if (existing.rowCount) return invite.list_id; // Already in — accepting again is a no-op.

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

    await client.query('INSERT INTO list_members (list_id, user_id, role) VALUES ($1, $2, $3)', [
      invite.list_id,
      user.id,
      invite.role,
    ]);
    await client.query('UPDATE invites SET use_count = use_count + 1 WHERE id = $1', [invite.id]);
    return invite.list_id;
  });

  await broadcast(listId, { type: 'members.changed', listId }, user.id);
  res.json({ listId });
});
