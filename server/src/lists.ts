import { DateTime } from 'luxon';
import type {
  Cadence,
  ListDetail,
  ListSummary,
  Member,
  Role,
  Task,
  UserRef,
  Weekday,
} from '@tally/shared';
import { roleAtLeast } from '@tally/shared';
import { query, queryOne } from './db.js';
import { periodAt, type PeriodSchedule } from './periods.js';
import { membersOfSpace } from './spaces.js';
import { forbidden, notFound } from './errors.js';

export interface ListRow {
  id: string;
  name: string;
  emoji: string;
  color: string;
  owner_id: string;
  space_id: string;
  private: boolean;
  timezone: string;
  reset_hour: number;
  cadence: Cadence;
  cadence_interval_days: number;
  week_start: Weekday;
  cadence_anchor: string;
  created_at: Date;
}

// cadence_anchor is a DATE; read it as text so the driver can't shift it into
// the server's timezone and move the every_n_days cycle by a day.
export const LIST_COLUMNS = `
  l.id, l.name, l.emoji, l.color, l.owner_id, l.space_id, l.private,
  l.timezone, l.reset_hour,
  l.cadence, l.cadence_interval_days, l.week_start,
  to_char(l.cadence_anchor, 'YYYY-MM-DD') AS cadence_anchor, l.created_at
`;

export function scheduleOf(row: ListRow): PeriodSchedule {
  return {
    cadence: row.cadence,
    cadenceIntervalDays: row.cadence_interval_days,
    weekStart: row.week_start,
    timezone: row.timezone,
    resetHour: row.reset_hour,
    cadenceAnchor: row.cadence_anchor,
  };
}

export interface ListAccess {
  list: ListRow;
  role: Role;
}

/**
 * The caller's role on one list, or null if they cannot see it at all.
 *
 * Two rules sit on top of the space role, and both are why this is a function
 * rather than a column in the query:
 *
 *  - **A private list belongs to its owner alone.** Not to the space's owner,
 *    not to anyone the space is later shared with. Otherwise "share this space"
 *    could never be a safe thing to agree to.
 *  - **You own what you made.** Someone who creates a list in a space they are
 *    only an editor of still gets to rename, reconfigure and delete it. `owner`
 *    is the top rank, so this is simply the stronger of the two grants.
 */
export function effectiveRole(
  list: { owner_id: string; private: boolean },
  spaceRole: Role | null,
  userId: string,
): Role | null {
  const owns = list.owner_id === userId;
  if (list.private) return owns ? 'owner' : null;
  if (owns) return 'owner';
  return spaceRole;
}

/**
 * Loads a list the caller can see, or refuses. A non-member gets 404 rather
 * than 403 — whether a list exists is itself private.
 */
export async function requireListAccess(
  listId: string,
  userId: string,
  needed: Role = 'viewer',
): Promise<ListAccess> {
  const found = await queryOne<ListRow & { space_role: Role | null }>(
    `SELECT ${LIST_COLUMNS}, m.role AS space_role
       FROM lists l
       LEFT JOIN space_members m ON m.space_id = l.space_id AND m.user_id = $2
      WHERE l.id = $1 AND l.archived_at IS NULL`,
    [listId, userId],
  );

  const role = found && effectiveRole(found, found.space_role, userId);
  if (!found || !role) throw notFound('That list');
  const row = { ...found, role };
  if (!roleAtLeast(role, needed)) {
    throw forbidden(
      needed === 'owner'
        ? 'Only the list owner can do that'
        : 'You can tick tasks off, but not change them',
    );
  }
  return { list: row, role: row.role };
}

function userRef(row: {
  id: string;
  display_name: string;
  email: string | null;
  photo_url: string | null;
}): UserRef {
  return { id: row.id, displayName: row.display_name, email: row.email, photoUrl: row.photo_url };
}

/**
 * Who can see this list: the members of its space, or — when it is private —
 * its owner and nobody else. The same answer drives the avatars on a list card
 * and the audience an event is delivered to.
 */
async function membersOf(list: ListRow): Promise<Member[]> {
  if (!list.private) return membersOfSpace(list.space_id);

  const rows = await query<{
    id: string;
    display_name: string;
    email: string | null;
    photo_url: string | null;
    joined_at: Date;
  }>(
    `SELECT u.id, u.display_name, u.email, u.photo_url, m.joined_at
       FROM users u
       LEFT JOIN space_members m ON m.user_id = u.id AND m.space_id = $2
      WHERE u.id = $1`,
    [list.owner_id, list.space_id],
  );
  return rows.map((row) => ({
    ...userRef(row),
    role: 'owner' as const,
    joinedAt: (row.joined_at ?? new Date(0)).toISOString(),
  }));
}

interface TaskRow {
  id: string;
  list_id: string;
  title: string;
  notes: string | null;
  position: number;
  completed_at: Date | null;
  by_id: string | null;
  by_name: string | null;
  by_email: string | null;
  by_photo: string | null;
}

/**
 * Tasks with their completion *for one specific period*. The period key is
 * passed in rather than looked up per row — that join condition is what makes
 * the list appear to reset.
 */
async function tasksOf(listId: string, periodKey: string): Promise<Task[]> {
  const rows = await query<TaskRow>(
    `SELECT t.id, t.list_id, t.title, t.notes, t.position,
            c.completed_at,
            u.id AS by_id, u.display_name AS by_name, u.email AS by_email, u.photo_url AS by_photo
       FROM tasks t
       LEFT JOIN task_completions c ON c.task_id = t.id AND c.period_key = $2
       LEFT JOIN users u ON u.id = c.completed_by
      WHERE t.list_id = $1 AND t.archived_at IS NULL
      -- Total, not merely deterministic: position can tie on the column default
      -- and created_at can tie inside one transaction. The same three columns
      -- order the move endpoint's snapshot, and the two have to agree.
      ORDER BY t.position, t.created_at, t.id`,
    [listId, periodKey],
  );

  return rows.map((row) => ({
    id: row.id,
    listId: row.list_id,
    title: row.title,
    notes: row.notes,
    position: row.position,
    completion: row.completed_at
      ? {
          at: row.completed_at.toISOString(),
          by: {
            id: row.by_id ?? '',
            // A removed account leaves its ticks behind; say so rather than showing a blank.
            displayName: row.by_name ?? 'Someone',
            email: row.by_email ?? null,
            photoUrl: row.by_photo ?? null,
          },
        }
      : null,
  }));
}

function summaryFrom(row: ListRow, role: Role, tasks: Task[], members: UserRef[]): ListSummary {
  const period = periodAt(scheduleOf(row));
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    color: row.color,
    ownerId: row.owner_id,
    spaceId: row.space_id,
    private: row.private,
    createdAt: row.created_at.toISOString(),
    cadence: row.cadence,
    cadenceIntervalDays: row.cadence_interval_days,
    weekStart: row.week_start,
    timezone: row.timezone,
    resetHour: row.reset_hour,
    role,
    taskCount: tasks.length,
    doneCount: tasks.filter((task) => task.completion).length,
    periodKey: period.key,
    resetsAt: period.end ? period.end.toISO() : null,
    members,
  };
}

/**
 * Every list the user can see, with today's progress on each.
 *
 * Reached through space membership rather than a per-list row, which is the
 * whole point of spaces: a list added to a space you are in is yours to see
 * without anybody sharing it with you again. Private lists are filtered out in
 * SQL rather than by `effectiveRole` below, so the rows never leave the
 * database in the first place.
 */
export async function listsForUser(userId: string): Promise<ListSummary[]> {
  const rows = await query<ListRow & { space_role: Role }>(
    `SELECT ${LIST_COLUMNS}, m.role AS space_role
       FROM lists l
       JOIN space_members m ON m.space_id = l.space_id
      WHERE m.user_id = $1 AND l.archived_at IS NULL
        AND (NOT l.private OR l.owner_id = $1)
      ORDER BY l.created_at`,
    [userId],
  );

  return Promise.all(
    rows.map(async (row) => {
      const period = periodAt(scheduleOf(row));
      const [tasks, members] = await Promise.all([tasksOf(row.id, period.key), membersOf(row)]);
      // Never null here: the join above already established membership.
      const role = effectiveRole(row, row.space_role, userId) ?? row.space_role;
      return summaryFrom(row, role, tasks, members);
    }),
  );
}

export async function listDetail(row: ListRow, role: Role): Promise<ListDetail> {
  const period = periodAt(scheduleOf(row));
  const [tasks, members] = await Promise.all([tasksOf(row.id, period.key), membersOf(row)]);
  return { ...summaryFrom(row, role, tasks, members), tasks, members };
}

/** Current period key for a list, as the server sees it. Clients never send this. */
export function currentPeriod(row: ListRow): { key: string; end: DateTime | null } {
  const period = periodAt(scheduleOf(row));
  return { key: period.key, end: period.end };
}
