import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Stats, StatsPerson } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcast } from '../events.js';
import { HttpError } from '../errors.js';
import {
  LIST_COLUMNS,
  currentPeriod,
  listDetail,
  listsForUser,
  requireListAccess,
  scheduleOf,
  type ListRow,
} from '../lists.js';
import { uuidParam } from '../http.js';
import { periodsBack } from '../periods.js';
import { summariseStats } from '../stats.js';

export const listsRouter: Router = Router();

const scheduleShape = {
  cadence: z.enum(['daily', 'weekly', 'monthly', 'every_n_days', 'none']),
  cadenceIntervalDays: z.number().int().min(2).max(365),
  weekStart: z.number().int().min(1).max(7),
  timezone: z
    .string()
    .max(64)
    .refine((tz) => DateTime.local().setZone(tz).isValid, 'Unknown timezone'),
  resetHour: z.number().int().min(0).max(23),
};

const createListSchema = z.object({
  name: z.string().trim().min(1, 'Give the list a name').max(80),
  emoji: z.string().trim().min(1).max(8).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value')
    .optional(),
  cadence: scheduleShape.cadence.optional(),
  cadenceIntervalDays: scheduleShape.cadenceIntervalDays.optional(),
  weekStart: scheduleShape.weekStart.optional(),
  timezone: scheduleShape.timezone.optional(),
  resetHour: scheduleShape.resetHour.optional(),
});

const updateListSchema = createListSchema.partial();

listsRouter.get('/', async (req, res) => {
  res.json(await listsForUser(authed(req).id));
});

listsRouter.post('/', async (req, res) => {
  const user = authed(req);
  const body = createListSchema.parse(req.body);

  const list = await transaction(async (client) => {
    const inserted = await client.query<ListRow>(
      `INSERT INTO lists (name, emoji, color, owner_id, timezone, reset_hour,
                          cadence, cadence_interval_days, week_start, cadence_anchor)
       VALUES ($1,
               COALESCE($2, '🏠'),
               COALESCE($3, '#9184d9'),
               $4,
               COALESCE($5, 'Europe/London'),
               COALESCE($6, 4),
               COALESCE($7, 'daily'),
               COALESCE($8, 3),
               COALESCE($9, 1),
               CURRENT_DATE)
       RETURNING id`,
      [
        body.name,
        body.emoji ?? null,
        body.color ?? null,
        user.id,
        body.timezone ?? null,
        body.resetHour ?? null,
        body.cadence ?? null,
        body.cadenceIntervalDays ?? null,
        body.weekStart ?? null,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new HttpError(500, 'Could not create the list');

    await client.query(
      `INSERT INTO list_members (list_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [id, user.id],
    );

    const row = await client.query<ListRow>(
      `SELECT ${LIST_COLUMNS} FROM lists l WHERE l.id = $1`,
      [id],
    );
    return row.rows[0]!;
  });

  res.status(201).json(await listDetail(list, 'owner'));
});

listsRouter.get('/:id', async (req, res) => {
  const { list, role } = await requireListAccess(uuidParam(req, 'id', 'That list'), authed(req).id);
  res.json(await listDetail(list, role));
});

listsRouter.patch('/:id', async (req, res) => {
  const user = authed(req);
  const { list } = await requireListAccess(uuidParam(req, 'id', 'That list'), user.id, 'owner');
  const body = updateListSchema.parse(req.body);

  // Restarting the anchor when the cadence becomes every_n_days makes the new
  // cycle begin today, which is what someone picking "every 3 days" expects.
  const restartAnchor = body.cadence === 'every_n_days' && list.cadence !== 'every_n_days';

  const updated = await queryOne<ListRow>(
    `UPDATE lists l SET
       name                  = COALESCE($2, l.name),
       emoji                 = COALESCE($3, l.emoji),
       color                 = COALESCE($4, l.color),
       timezone              = COALESCE($5, l.timezone),
       reset_hour            = COALESCE($6, l.reset_hour),
       cadence               = COALESCE($7, l.cadence),
       cadence_interval_days = COALESCE($8, l.cadence_interval_days),
       week_start            = COALESCE($9, l.week_start),
       cadence_anchor        = CASE WHEN $10 THEN CURRENT_DATE ELSE l.cadence_anchor END
     WHERE l.id = $1
     RETURNING ${LIST_COLUMNS}`,
    [
      list.id,
      body.name ?? null,
      body.emoji ?? null,
      body.color ?? null,
      body.timezone ?? null,
      body.resetHour ?? null,
      body.cadence ?? null,
      body.cadenceIntervalDays ?? null,
      body.weekStart ?? null,
      restartAnchor,
    ],
  );
  if (!updated) throw new HttpError(500, 'Could not save those settings');

  await broadcast(list.id, { type: 'list.changed', listId: list.id }, user.id);
  res.json(await listDetail(updated, 'owner'));
});

listsRouter.delete('/:id', async (req, res) => {
  const user = authed(req);
  const { list } = await requireListAccess(uuidParam(req, 'id', 'That list'), user.id, 'owner');
  await broadcast(list.id, { type: 'list.deleted', listId: list.id });
  await query('DELETE FROM lists WHERE id = $1', [list.id]);
  res.status(204).end();
});

/* ── Tasks belonging to a list ───────────────────────────────────────────── */

const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Give the task a name').max(140),
  notes: z.string().trim().max(500).nullish(),
});

listsRouter.post('/:id/tasks', async (req, res) => {
  const user = authed(req);
  const { list, role } = await requireListAccess(uuidParam(req, 'id', 'That list'), user.id, 'editor');
  const body = createTaskSchema.parse(req.body);

  const last = await queryOne<{ max: number | null }>(
    'SELECT MAX(position) AS max FROM tasks WHERE list_id = $1 AND archived_at IS NULL',
    [list.id],
  );

  const task = await queryOne<{ id: string }>(
    `INSERT INTO tasks (list_id, title, notes, position, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [list.id, body.title, body.notes || null, (last?.max ?? 0) + 1, user.id],
  );
  if (!task) throw new HttpError(500, 'Could not add that task');

  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  res.status(201).json(await listDetail(list, role));
});

/* ── Stats ───────────────────────────────────────────────────────────────── */

/** How far back to look for a streak, regardless of the requested window. */
const STREAK_LOOKBACK = 60;

listsRouter.get('/:id/stats', async (req, res) => {
  const { list } = await requireListAccess(uuidParam(req, 'id', 'That list'), authed(req).id);
  const window = Math.min(90, Math.max(1, Number(req.query.window ?? 7) || 7));

  const schedule = scheduleOf(list);
  const periods = periodsBack(schedule, Math.max(window, STREAK_LOOKBACK));
  const keys = periods.map((period) => period.key);

  const tasks = await query<{ id: string; created_at: Date; archived_at: Date | null }>(
    'SELECT id, created_at, archived_at FROM tasks WHERE list_id = $1',
    [list.id],
  );

  const completions = await query<{ task_id: string; period_key: string; completed_by: string | null }>(
    `SELECT c.task_id, c.period_key, c.completed_by
       FROM task_completions c
       JOIN tasks t ON t.id = c.task_id
      WHERE t.list_id = $1 AND c.period_key = ANY($2::text[])`,
    [list.id, keys],
  );

  const totals = summariseStats({
    periods,
    window,
    tasks: tasks.map((task) => ({
      id: task.id,
      createdAt: task.created_at,
      archivedAt: task.archived_at,
    })),
    completions: completions.map((row) => ({
      taskId: row.task_id,
      periodKey: row.period_key,
      completedBy: row.completed_by,
    })),
    now: DateTime.utc(),
  });

  const members = await query<{
    id: string;
    display_name: string;
    email: string | null;
    photo_url: string | null;
  }>(
    `SELECT u.id, u.display_name, u.email, u.photo_url
       FROM list_members m JOIN users u ON u.id = m.user_id
      WHERE m.list_id = $1`,
    [list.id],
  );

  const people: StatsPerson[] = members
    .map((member) => ({
      id: member.id,
      displayName: member.display_name,
      email: member.email,
      photoUrl: member.photo_url,
      count: totals.perUser.get(member.id) ?? 0,
    }))
    .sort((a, b) => b.count - a.count);

  const stats: Stats = {
    window: totals.window,
    streak: totals.streak,
    done: totals.done,
    total: totals.total,
    people,
  };
  res.json(stats);
});

/** Exposed for tests and for the tasks router, which needs the same period. */
export { currentPeriod };
