import { Router } from 'express';
import type { Me } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne } from '../db.js';
import { notFound } from '../errors.js';
import { broadcast } from '../events.js';
import { deleteAuthUser } from '../firebase.js';
import { updateMeSchema } from '../profile.js';

/**
 * Your own profile. Everything here is scoped to the caller — there is no id in
 * any path or body, because the only account anybody may touch is their own.
 */
export const meRouter: Router = Router();

interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  photo_url: string | null;
}

const toMe = (row: UserRow): Me => ({
  id: row.id,
  displayName: row.display_name,
  email: row.email,
  photoUrl: row.photo_url,
});

meRouter.get('/', (req, res) => {
  const user = authed(req);
  res.json({
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    photoUrl: user.photoUrl,
  } satisfies Me);
});

meRouter.patch('/', async (req, res) => {
  const user = authed(req);
  const body = updateMeSchema.parse(req.body);

  // `display_name_custom` is what stops requireAuth's upsert overwriting this
  // from the provider's claims on the person's very next request.
  const row = await queryOne<UserRow>(
    `UPDATE users
        SET display_name = $2,
            display_name_custom = true
      WHERE id = $1
      RETURNING id, display_name, email, photo_url`,
    [user.id, body.displayName],
  );
  if (!row) throw notFound('Your account');

  // This name is on an avatar in every list they share, so tell those lists
  // rather than waiting for everyone else to refetch.
  for (const listId of await listsSharedWith(user.id)) {
    await broadcast(listId, { type: 'members.changed', listId });
  }

  res.json(toMe(row));
});

meRouter.delete('/', async (req, res) => {
  const user = authed(req);

  // Gathered and announced *before* the delete: the audience for an event is
  // resolved from `list_members`, and the cascade is about to empty it.
  const owned = (
    await query<{ id: string }>('SELECT id FROM lists WHERE owner_id = $1', [user.id])
  ).map((row) => row.id);
  const ownedIds = new Set(owned);
  const shared = await listsSharedWith(user.id);

  for (const listId of owned) {
    // Deleting the account deletes the lists it owns, for everyone on them —
    // `lists.owner_id` cascades. The frontend says so out loud before it fires.
    await broadcast(listId, { type: 'list.deleted', listId });
  }
  for (const listId of shared) {
    if (ownedIds.has(listId)) continue;
    await broadcast(listId, { type: 'members.changed', listId });
  }

  // One row, and the foreign keys do the rest: memberships and owned lists
  // cascade, while `tasks.created_by` and `task_completions.completed_by` go
  // null so the history the stats are made of survives losing its author.
  await query('DELETE FROM users WHERE id = $1', [user.id]);

  // Best effort, after the fact: the profile is already gone, and a Firebase
  // outage must not report a delete that did happen as a failure.
  await deleteAuthUser(user.firebaseUid);

  res.status(204).end();
});

/** The lists the person is on, owned or merely joined. */
async function listsSharedWith(userId: string): Promise<string[]> {
  const rows = await query<{ list_id: string }>(
    'SELECT list_id FROM list_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((row) => row.list_id);
}
