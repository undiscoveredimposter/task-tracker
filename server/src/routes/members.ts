import { Router } from 'express';
import { z } from 'zod';
import { authed } from '../auth.js';
import { query } from '../db.js';
import { broadcast } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import { listDetail, requireListAccess } from '../lists.js';
import { param } from '../http.js';

export const membersRouter: Router = Router({ mergeParams: true });

const roleSchema = z.object({ role: z.enum(['editor', 'viewer']) });

membersRouter.get('/', async (req, res) => {
  const { list, role } = await requireListAccess(param(req, 'id'), authed(req).id);
  const detail = await listDetail(list, role);
  res.json(detail.members);
});

membersRouter.patch('/:userId', async (req, res) => {
  const user = authed(req);
  const { list } = await requireListAccess(param(req, 'id'), user.id, 'owner');
  const body = roleSchema.parse(req.body);

  if (param(req, 'userId') === list.owner_id) {
    throw new HttpError(400, "The owner's role can't be changed");
  }

  const updated = await query(
    `UPDATE list_members SET role = $3
      WHERE list_id = $1 AND user_id = $2 AND role <> 'owner'
      RETURNING user_id`,
    [list.id, param(req, 'userId'), body.role],
  );
  if (updated.length === 0) throw notFound('That member');

  await broadcast(list.id, { type: 'members.changed', listId: list.id });
  res.status(204).end();
});

membersRouter.delete('/:userId', async (req, res) => {
  const user = authed(req);
  const leaving = param(req, 'userId') === user.id;

  // Removing yourself is "leave", which any member may do; removing someone
  // else is a membership change, which only the owner may do.
  const { list } = await requireListAccess(param(req, 'id'), user.id, leaving ? 'viewer' : 'owner');

  if (param(req, 'userId') === list.owner_id) {
    throw new HttpError(
      400,
      leaving
        ? "You own this list — delete it instead, or hand it over first"
        : "The owner can't be removed",
    );
  }

  const removed = await query(
    `DELETE FROM list_members WHERE list_id = $1 AND user_id = $2 AND role <> 'owner' RETURNING user_id`,
    [list.id, param(req, 'userId')],
  );
  if (removed.length === 0) throw notFound('That member');

  await broadcast(list.id, { type: 'members.changed', listId: list.id });
  res.status(204).end();
});
