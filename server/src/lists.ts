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
import { forbidden, notFound } from './errors.js';

export interface ListRow {
  id: string;
  name: string;
  emoji: string;
  color: string;
  owner_id: string;
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
  l.id, l.name, l.emoji, l.color, l.owner_id, l.timezone, l.reset_hour,
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
 * Loads a list the caller can see, or refuses. A non-member gets 404 rather
 * than 403 — whether a list exists is itself private.
 */
export async function requireListAccess(
  listId: string,
  userId: string,
  needed: Role = 'viewer',
): Promise<ListAccess> {
  const row = await queryOne<ListRow & { role: Role | null }>(
    `SELECT ${LIST_COLUMNS}, m.role
       FROM lists l
       LEFT JOIN list_members m ON m.list_id = l.id AND m.user_id = $2
      WHERE l.id = $1 AND l.archived_at IS NULL`,
    [listId, userId],
  );

  if (!row || !row.role) throw notFound('That list');
  if (!roleAtLeast(row.role, needed)) {
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

async function membersOf(listId: string): Promise<Member[]> {
  const rows = await query<{
    id: string;
    display_name: string;
    email: string | null;
    photo_url: string | null;
    role: Role;
    joined_at: Date;
  }>(
    `SELECT u.id, u.display_name, u.email, u.photo_url, m.role, m.joined_at
       FROM list_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.list_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.joined_at`,
    [listId],
  );
  return rows.map((row) => ({ ...userRef(row), role: row.role, joinedAt: row.joined_at.toISOString() }));
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
      ORDER BY t.position, t.created_at`,
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

/** Every list the user belongs to, with today's progress on each. */
export async function listsForUser(userId: string): Promise<ListSummary[]> {
  const rows = await query<ListRow & { role: Role }>(
    `SELECT ${LIST_COLUMNS}, m.role
       FROM lists l
       JOIN list_members m ON m.list_id = l.id
      WHERE m.user_id = $1 AND l.archived_at IS NULL
      ORDER BY l.created_at`,
    [userId],
  );

  return Promise.all(
    rows.map(async (row) => {
      const period = periodAt(scheduleOf(row));
      const [tasks, members] = await Promise.all([tasksOf(row.id, period.key), membersOf(row.id)]);
      return summaryFrom(row, row.role, tasks, members);
    }),
  );
}

export async function listDetail(row: ListRow, role: Role): Promise<ListDetail> {
  const period = periodAt(scheduleOf(row));
  const [tasks, members] = await Promise.all([tasksOf(row.id, period.key), membersOf(row.id)]);
  return { ...summaryFrom(row, role, tasks, members), tasks, members };
}

/** Current period key for a list, as the server sees it. Clients never send this. */
export function currentPeriod(row: ListRow): { key: string; end: DateTime | null } {
  const period = periodAt(scheduleOf(row));
  return { key: period.key, end: period.end };
}
