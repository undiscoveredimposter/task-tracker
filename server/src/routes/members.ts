import { Router } from 'express';
import { z } from 'zod';
import { authed } from '../auth.js';
import { query, transaction } from '../db.js';
import { broadcastSpace, sendTo } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import { ensurePersonalSpace, membersOfSpace, requireSpaceAccess } from '../spaces.js';
import { param, uuidParam } from '../http.js';

/**
 * Who is in a space, mounted under /api/spaces/:id/members.
 *
 * This is the whole of membership now: there is no per-list equivalent, because
 * a role here is a role on every list in the space.
 */
export const membersRouter: Router = Router({ mergeParams: true });

const roleSchema = z.object({ role: z.enum(['editor', 'viewer']) });

membersRouter.get('/', async (req, res) => {
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), authed(req).id);
  res.json(await membersOfSpace(space.id));
});

membersRouter.patch('/:userId', async (req, res) => {
  const user = authed(req);
  const { space } = await requireSpaceAccess(uuidParam(req, 'id', 'That space'), user.id, 'owner');
  const body = roleSchema.parse(req.body);

  // Checked after the space, never before: a malformed member id must not be a
  // way to tell a space you can't see from one that was never there.
  const memberId = uuidParam(req, 'userId', 'That member');

  if (memberId === space.owner_id) {
    throw new HttpError(400, "The owner's role can't be changed");
  }

  const updated = await query(
    `UPDATE space_members SET role = $3
      WHERE space_id = $1 AND user_id = $2 AND role <> 'owner'
      RETURNING user_id`,
    [space.id, memberId, body.role],
  );
  if (updated.length === 0) throw notFound('That member');

  await broadcastSpace(space.id, { type: 'space.changed', spaceId: space.id });
  res.status(204).end();
});

membersRouter.delete('/:userId', async (req, res) => {
  const user = authed(req);
  // Read raw, because it decides which role the access check below demands and
  // so has to be known first. Safe: a malformed id can never equal a real one,
  // so it can only ever fall through to the stricter branch.
  const leaving = param(req, 'userId') === user.id;

  // Removing yourself is "leave", which any member may do; removing someone
  // else is a membership change, which only the owner may do.
  const { space } = await requireSpaceAccess(
    uuidParam(req, 'id', 'That space'),
    user.id,
    leaving ? 'viewer' : 'owner',
  );

  const memberId = uuidParam(req, 'userId', 'That member');

  if (memberId === space.owner_id) {
    throw new HttpError(
      400,
      leaving
        ? 'You own this space — delete it instead, or hand it over first'
        : "The owner can't be removed",
    );
  }

  await transaction(async (client) => {
    const removed = await client.query(
      `DELETE FROM space_members WHERE space_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING user_id`,
      [space.id, memberId],
    );
    if (removed.rowCount === 0) throw notFound('That member');

    // Lists they made here would otherwise stay behind: still visible to the
    // space, and owned by somebody who can no longer reach them. They leave
    // with the person who made them, into a space of their own.
    const owned = await client.query<{ display_name: string }>(
      `SELECT u.display_name FROM users u
        WHERE u.id = $1 AND EXISTS (
          SELECT 1 FROM lists l WHERE l.space_id = $2 AND l.owner_id = $1
        )`,
      [memberId, space.id],
    );
    const name = owned.rows[0]?.display_name;
    if (name === undefined) return;

    const personal = await ensurePersonalSpace(client, memberId, name);
    await client.query('UPDATE lists SET space_id = $3 WHERE space_id = $1 AND owner_id = $2', [
      space.id,
      memberId,
      personal,
    ]);
  });

  await broadcastSpace(space.id, { type: 'space.changed', spaceId: space.id });
  // The person who just left is out of the audience above, and their client is
  // still holding this space's lists. Tell them directly so they let go of them.
  sendTo(memberId, { type: 'space.changed', spaceId: space.id });

  res.status(204).end();
});
