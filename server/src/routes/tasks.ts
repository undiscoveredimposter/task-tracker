import { Router } from 'express';
import { z } from 'zod';
import type { Completion, Role } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcast } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import {
  LIST_COLUMNS,
  currentPeriod,
  listDetail,
  requireListAccess,
  type ListRow,
} from '../lists.js';
import { param } from '../http.js';
import { planMove, type MoveRefusal, type MoveResult } from '../ordering.js';

export const tasksRouter: Router = Router();

interface TaskAccess {
  task: { id: string; title: string };
  list: ListRow;
  role: Role;
}

/** Resolves a task to its list, then applies the list's role rules. */
async function taskAccess(taskId: string, userId: string, needed: Role = 'viewer'): Promise<TaskAccess> {
  const row = await queryOne<{ id: string; title: string; list_id: string }>(
    'SELECT id, title, list_id FROM tasks WHERE id = $1 AND archived_at IS NULL',
    [taskId],
  );
  if (!row) throw notFound('That task');

  const { list, role } = await requireListAccess(row.list_id, userId, needed);
  return { task: { id: row.id, title: row.title }, list, role };
}

const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  notes: z.string().trim().max(500).nullish(),
  position: z.number().finite().optional(),
});

tasksRouter.patch('/:id', async (req, res) => {
  const user = authed(req);
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'editor');
  const body = updateTaskSchema.parse(req.body);

  await query(
    `UPDATE tasks SET
       title    = COALESCE($2, title),
       notes    = CASE WHEN $3::boolean THEN $4 ELSE notes END,
       position = COALESCE($5, position)
     WHERE id = $1`,
    [
      task.id,
      body.title ?? null,
      body.notes !== undefined,
      body.notes ? body.notes : null,
      body.position ?? null,
    ],
  );

  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  res.status(204).end();
});

/* ── Reordering ──────────────────────────────────────────────────────────── */

// Anchors are matched against ids already loaded from this list, never
// interpolated into a query, so they only need to be bounded strings — an
// anchor that isn't in the list is a 404 rather than a cast error.
const moveTaskSchema = z
  .object({
    before: z.string().trim().min(1).max(64).nullish(),
    after: z.string().trim().min(1).max(64).nullish(),
  })
  .refine((body) => Boolean(body.before) || Boolean(body.after), {
    message: 'Say which task to move this one before or after',
  });

/** Turns a refusal from the pure planner into the response it deserves. */
function moveRefused(reason: MoveRefusal): HttpError {
  switch (reason) {
    // Both mean "no such task in a list you can see" — same answer either way,
    // because whether someone else's task exists is not ours to reveal.
    case 'unknown_task':
    case 'unknown_anchor':
      return notFound('That task');
    case 'anchor_is_task':
      return new HttpError(400, 'A task cannot be moved relative to itself');
    case 'anchors_not_adjacent':
      return new HttpError(400, "Those two tasks aren't next to each other");
    case 'no_anchor':
      return new HttpError(400, 'Say which task to move this one before or after');
  }
}

tasksRouter.post('/:id/move', async (req, res) => {
  const user = authed(req);
  // Viewers tick; only editors rearrange.
  const { task, list, role } = await taskAccess(param(req, 'id'), user.id, 'editor');
  const body = moveTaskSchema.parse(req.body ?? {});

  const result = await transaction<MoveResult>(async (client) => {
    // FOR UPDATE over the whole list, not just the moved row: two people
    // dragging at once must not interleave a midpoint with a renumber, or one
    // of them writes a position into an ordering that no longer exists.
    const { rows } = await client.query<{ id: string; position: number; created_at: Date }>(
      `SELECT id, position, created_at
         FROM tasks
        WHERE list_id = $1 AND archived_at IS NULL
        ORDER BY position, created_at, id
          FOR UPDATE`,
      [list.id],
    );

    const planned = planMove({
      tasks: rows.map((row) => ({ id: row.id, position: row.position, createdAt: row.created_at })),
      taskId: task.id,
      before: body.before ?? null,
      after: body.after ?? null,
    });
    if (!planned.ok) return planned;

    if (planned.plan.kind === 'set') {
      await client.query('UPDATE tasks SET position = $2 WHERE id = $1', [
        planned.plan.id,
        planned.plan.position,
      ]);
    } else if (planned.plan.kind === 'renumber') {
      // One statement, one transaction: the list is never briefly half-renumbered.
      await client.query(
        `UPDATE tasks SET position = fresh.position
           FROM unnest($1::uuid[], $2::double precision[]) AS fresh(id, position)
          WHERE tasks.id = fresh.id`,
        [
          planned.plan.positions.map((entry) => entry.id),
          planned.plan.positions.map((entry) => entry.position),
        ],
      );
    }

    return planned;
  });

  if (!result.ok) throw moveRefused(result.reason);

  // A renumber can change every row, so hand back the whole list rather than
  // leaving the client to guess which positions moved.
  if (result.plan.kind !== 'noop') {
    await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  }
  res.json(await listDetail(list, role));
});

tasksRouter.delete('/:id', async (req, res) => {
  const user = authed(req);
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'editor');

  // Soft delete — the completions behind it are what the stats are made of.
  await query('UPDATE tasks SET archived_at = now() WHERE id = $1', [task.id]);
  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  res.status(204).end();
});

/* ── Ticking off ─────────────────────────────────────────────────────────── */

tasksRouter.post('/:id/complete', async (req, res) => {
  const user = authed(req);
  // Viewers can tick — that is the whole point of a viewer.
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'viewer');
  const period = currentPeriod(list);

  // The period key comes from the server, never the client, so two phones with
  // different clocks cannot disagree about which day a tick belongs to.
  // ON CONFLICT makes this idempotent: a replayed offline tick or a
  // simultaneous tap returns the first writer's row rather than erroring.
  const row = await queryOne<{ completed_at: Date; completed_by: string | null }>(
    `INSERT INTO task_completions (task_id, period_key, completed_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (task_id, period_key)
       DO UPDATE SET task_id = task_completions.task_id
     RETURNING completed_at, completed_by`,
    [task.id, period.key, user.id],
  );
  if (!row) throw new HttpError(500, 'Could not save that tick');

  const by = await queryOne<{
    id: string;
    display_name: string;
    email: string | null;
    photo_url: string | null;
  }>('SELECT id, display_name, email, photo_url FROM users WHERE id = $1', [row.completed_by]);

  const completion: Completion = {
    at: row.completed_at.toISOString(),
    by: {
      id: by?.id ?? user.id,
      displayName: by?.display_name ?? user.displayName,
      email: by?.email ?? null,
      photoUrl: by?.photo_url ?? null,
    },
  };

  await broadcast(
    list.id,
    { type: 'task.completed', listId: list.id, taskId: task.id, periodKey: period.key, completion },
    user.id,
  );
  res.json({ taskId: task.id, periodKey: period.key, completion });
});

tasksRouter.delete('/:id/complete', async (req, res) => {
  const user = authed(req);
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'viewer');
  const period = currentPeriod(list);

  await query('DELETE FROM task_completions WHERE task_id = $1 AND period_key = $2', [
    task.id,
    period.key,
  ]);

  await broadcast(
    list.id,
    { type: 'task.uncompleted', listId: list.id, taskId: task.id, periodKey: period.key },
    user.id,
  );
  res.status(204).end();
});

/** Re-exported so the router file above can stay focused on lists. */
export { LIST_COLUMNS };
