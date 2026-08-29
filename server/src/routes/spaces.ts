import { Router } from 'express';
import { z } from 'zod';
import type { SpaceSummary } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcastSpace } from '../events.js';
import { HttpError } from '../errors.js';
import { uuidParam } from '../http.js';
import {
  SPACE_COLUMNS,
  membersOfSpace,
  requireSpaceAccess,
  spacesForUser,
  type SpaceRow,
} from '../spaces.js';

/**
 * Spaces: the thing you share, and everything inside it comes along.
 *
 * Membership and invites hang off a space rather than a list — see spaces.ts
 * for why, and routes/members.ts and routes/invites.ts for the two routers
 * mounted underneath this one.
 */
export const spacesRouter: Router = Router();

const spaceSchema = z.object({
  name: z.string().trim().min(1, 'Give the space a name').max(80),
  emoji: z.string().trim().min(1).max(8).optional(),
});

const updateSpaceSchema = spaceSchema.partial();

async function summaryOf(space: SpaceRow, role: SpaceSummary['role'], listCount: number): Promise<SpaceSummary> {
  return {
    id: space.id,
    name: space.name,
    emoji: space.emoji,
    ownerId: space.owner_id,
    createdAt: space.created_at.toISOString(),
    role,
    listCount,
    members: await membersOfSpace(space.id),
  };
}

spacesRouter.get('/', async (req, res) => {
  res.json(await spacesForUser(authed(req).id));
});

spacesRouter.post('/', async (req, res) => {
  const user = authed(req);
  const body = spaceSchema.parse(req.body);

  const space = await transaction(async (client) => {
    const inserted = await client.query<SpaceRow>(
      `INSERT INTO spaces (name, emoji, owner_id) VALUES ($1, COALESCE($2, '🏠'), $3)
       RETURNING id, name, emoji, owner_id, created_at`,
      [body.name, body.emoji ?? null, user.id],
    );
    const row = inserted.rows[0];
    if (!row) throw new HttpError(500, 'Could not create that space');

    await client.query(
      `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [row.id, user.id],
    );
    return row;
  });

  res.status(201).json(await summaryOf(space, 'owner', 0));
});

spacesRouter.get('/:id', async (req, res) => {
  const user = authed(req);
  const { space, role } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id);
  const count = await queryOne<{ count: number }>(
    `SELECT count(*) AS count FROM lists
      WHERE space_id = $1 AND archived_at IS NULL AND (NOT private OR owner_id = $2)`,
    [space.id, user.id],
  );
  res.json(await summaryOf(space, role, count?.count ?? 0));
});

spacesRouter.patch('/:id', async (req, res) => {
  const user = authed(req);
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id, 'owner');
  const body = updateSpaceSchema.parse(req.body);

  const updated = await queryOne<SpaceRow>(
    `UPDATE spaces s SET name = COALESCE($2, s.name), emoji = COALESCE($3, s.emoji)
      WHERE s.id = $1
      RETURNING ${SPACE_COLUMNS}`,
    [space.id, body.name ?? null, body.emoji ?? null],
  );
  if (!updated) throw new HttpError(500, 'Could not save that space');

  await broadcastSpace(space.id, { type: 'space.changed', spaceId: space.id }, user.id);

  const count = await queryOne<{ count: number }>(
    `SELECT count(*) AS count FROM lists
      WHERE space_id = $1 AND archived_at IS NULL AND (NOT private OR owner_id = $2)`,
    [space.id, user.id],
  );
  res.json(await summaryOf(updated, 'owner', count?.count ?? 0));
});

spacesRouter.delete('/:id', async (req, res) => {
  const user = authed(req);
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id, 'owner');

  // `lists.space_id` cascades, so deleting a space with lists in it would take
  // them — including other people's, and including ones the owner cannot see.
  // Refuse instead: emptying it first is one decision per list, made by
  // somebody who can see what they are deciding about.
  const remaining = await queryOne<{ count: number }>(
    'SELECT count(*) AS count FROM lists WHERE space_id = $1',
    [space.id],
  );
  if ((remaining?.count ?? 0) > 0) {
    throw new HttpError(
      409,
      'This space still has lists in it — move or delete them first',
      'space_not_empty',
    );
  }

  await broadcastSpace(space.id, { type: 'space.changed', spaceId: space.id });
  await query('DELETE FROM spaces WHERE id = $1', [space.id]);
  res.status(204).end();
});
