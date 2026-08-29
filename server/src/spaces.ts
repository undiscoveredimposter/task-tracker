import type { Member, Role, SpaceSummary, UserRef } from '@tally/shared';
import { roleAtLeast } from '@tally/shared';
import { query, queryOne, type Queryable } from './db.js';
import { forbidden, notFound } from './errors.js';

/**
 * Spaces — who a set of lists is shared with.
 *
 * Membership lives here and nowhere else. A person holds one role in a space,
 * and that role is their role on every list inside it, which is what makes
 * "share this with the household" a thing you do once rather than once per
 * list. The two exceptions are deliberate and both live in `lists.ts`: a list's
 * own owner always has owner rights on it, and a `private` list is invisible to
 * everyone else however the space is shared.
 */

export interface SpaceRow {
  id: string;
  name: string;
  emoji: string;
  owner_id: string;
  created_at: Date;
}

export const SPACE_COLUMNS = `s.id, s.name, s.emoji, s.owner_id, s.created_at`;

export interface SpaceAccess {
  space: SpaceRow;
  role: Role;
}

/**
 * Loads a space the caller belongs to, or refuses. Like `requireListAccess`, a
 * non-member gets 404 rather than 403: whether a space exists is itself private.
 */
export async function requireSpaceAccess(
  spaceId: string,
  userId: string,
  needed: Role = 'viewer',
): Promise<SpaceAccess> {
  const row = await queryOne<SpaceRow & { role: Role | null }>(
    `SELECT ${SPACE_COLUMNS}, m.role
       FROM spaces s
       LEFT JOIN space_members m ON m.space_id = s.id AND m.user_id = $2
      WHERE s.id = $1`,
    [spaceId, userId],
  );

  if (!row || !row.role) throw notFound('That space');
  if (!roleAtLeast(row.role, needed)) {
    throw forbidden(
      needed === 'owner'
        ? 'Only the owner of this space can do that'
        : 'You can tick tasks off, but not change them',
    );
  }
  return { space: row, role: row.role };
}

function userRef(row: {
  id: string;
  display_name: string;
  email: string | null;
  photo_url: string | null;
}): UserRef {
  return { id: row.id, displayName: row.display_name, email: row.email, photoUrl: row.photo_url };
}

export async function membersOfSpace(spaceId: string): Promise<Member[]> {
  const rows = await query<{
    id: string;
    display_name: string;
    email: string | null;
    photo_url: string | null;
    role: Role;
    joined_at: Date;
  }>(
    `SELECT u.id, u.display_name, u.email, u.photo_url, m.role, m.joined_at
       FROM space_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at`,
    [spaceId],
  );
  return rows.map((row) => ({
    ...userRef(row),
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
  }));
}

/** Every space the caller is in, oldest first — the order the home screen shows. */
export async function spacesForUser(userId: string): Promise<SpaceSummary[]> {
  const rows = await query<SpaceRow & { role: Role; list_count: number }>(
    `SELECT ${SPACE_COLUMNS}, m.role,
            (SELECT count(*) FROM lists l
              WHERE l.space_id = s.id AND l.archived_at IS NULL
                -- A private list is one only its owner can see, so it is one
                -- only its owner can count.
                AND (NOT l.private OR l.owner_id = $1)) AS list_count
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      ORDER BY s.created_at, s.id`,
    [userId],
  );

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      emoji: row.emoji,
      ownerId: row.owner_id,
      createdAt: row.created_at.toISOString(),
      role: row.role,
      listCount: row.list_count,
      members: await membersOfSpace(row.id),
    })),
  );
}

/** What a space made for one person is called before they rename it. */
export function personalSpaceName(displayName: string): string {
  return displayName.trim() ? `${displayName.trim()}’s home` : 'Home';
}

/**
 * The caller's own space, made on demand.
 *
 * Nobody is given one at sign-up: an account with nothing in it has nothing to
 * share, and an empty space on the home screen is clutter that has to be
 * explained. The first list someone makes brings one into existence, which is
 * also what migration 004 did for every account that already had lists.
 */
export async function ensurePersonalSpace(
  client: Queryable,
  userId: string,
  displayName: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT s.id FROM spaces s
      JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
     WHERE s.owner_id = $1
     ORDER BY s.created_at, s.id
     LIMIT 1`,
    [userId],
  );
  const found = existing.rows[0];
  if (found) return found.id;

  const created = await client.query<{ id: string }>(
    'INSERT INTO spaces (name, emoji, owner_id) VALUES ($1, $2, $3) RETURNING id',
    [personalSpaceName(displayName), '🏠', userId],
  );
  const space = created.rows[0];
  if (!space) throw new Error('Could not create a personal space');

  await client.query(
    `INSERT INTO space_members (space_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [space.id, userId],
  );
  return space.id;
}
