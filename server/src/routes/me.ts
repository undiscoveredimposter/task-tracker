import { Router } from 'express';
import type { Me } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { notFound } from '../errors.js';
import { broadcast, broadcastSpace } from '../events.js';
import { ensurePersonalSpace } from '../spaces.js';
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

  // This name is on an avatar in every space they are in, so tell those spaces
  // rather than waiting for everyone else to refetch.
  for (const spaceId of await spacesOf(user.id)) {
    await broadcastSpace(spaceId, { type: 'space.changed', spaceId });
  }

  res.json(toMe(row));
});

meRouter.delete('/', async (req, res) => {
  const user = authed(req);

  // Deleting the account deletes the spaces it owns, and `lists.space_id`
  // cascades from there — which would take other people's lists with it, in a
  // space they were invited into. Move those out first, into a space of their
  // owner's own. Only lists this person actually owns are theirs to delete.
  await transaction(async (client) => {
    const stranded = await client.query<{ owner_id: string; display_name: string }>(
      `SELECT DISTINCT l.owner_id, u.display_name
         FROM lists l
         JOIN spaces s ON s.id = l.space_id
         JOIN users u ON u.id = l.owner_id
        WHERE s.owner_id = $1 AND l.owner_id <> $1`,
      [user.id],
    );

    for (const row of stranded.rows) {
      const personal = await ensurePersonalSpace(client, row.owner_id, row.display_name);
      await client.query(
        `UPDATE lists SET space_id = $3
           FROM spaces s
          WHERE lists.space_id = s.id AND s.owner_id = $1 AND lists.owner_id = $2`,
        [user.id, row.owner_id, personal],
      );
    }
  });

  // Gathered and announced *before* the delete: the audience for an event is
  // resolved from `space_members`, and the cascade is about to empty it.
  const owned = (
    await query<{ id: string }>('SELECT id FROM lists WHERE owner_id = $1', [user.id])
  ).map((row) => row.id);
  const spaces = await spacesOf(user.id);

  for (const listId of owned) {
    // Deleting the account deletes the lists it owns, for everyone who could
    // see them — `lists.owner_id` cascades. The frontend says so out loud
    // before it fires.
    await broadcast(listId, { type: 'list.deleted', listId });
  }
  for (const spaceId of spaces) {
    await broadcastSpace(spaceId, { type: 'space.changed', spaceId });
  }

  // One row, and the foreign keys do the rest: memberships, owned spaces and
  // owned lists cascade, while `tasks.created_by` and
  // `task_completions.completed_by` go null so the history the stats are made
  // of survives losing its author.
  await query('DELETE FROM users WHERE id = $1', [user.id]);

  // Best effort, after the fact: the profile is already gone, and a Firebase
  // outage must not report a delete that did happen as a failure.
  await deleteAuthUser(user.firebaseUid);

  res.status(204).end();
});

/** The spaces the person is in, owned or merely joined. */
async function spacesOf(userId: string): Promise<string[]> {
  const rows = await query<{ space_id: string }>(
    'SELECT space_id FROM space_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((row) => row.space_id);
}
