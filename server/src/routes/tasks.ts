import { Router } from 'express';
import { z } from 'zod';
import type { Completion, Role } from '@tally/shared';
import { authed } from '../auth.js';
import { query, queryOne, transaction } from '../db.js';
import { broadcast } from '../events.js';
import { HttpError, notFound } from '../errors.js';
import { LIST_COLUMNS, currentPeriod, listDetail, requireListAccess, type ListRow } from '../lists.js';
import { param } from '../http.js';
import { planMove, type MoveRefusal, type OrderedTask } from '../ordering.js';

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

// `position` is deliberately not settable here. Ordering goes through
// POST /:id/move, which computes the float server-side — a client that could
// write a raw position could also walk the list into the degenerate state the
// move endpoint exists to avoid.
const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  notes: z.string().trim().max(500).nullish(),
});

tasksRouter.patch('/:id', async (req, res) => {
  const user = authed(req);
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'editor');
  const body = updateTaskSchema.parse(req.body);

  await query(
    `UPDATE tasks SET
       title = COALESCE($2, title),
       notes = CASE WHEN $3::boolean THEN $4 ELSE notes END
     WHERE id = $1`,
    [task.id, body.title ?? null, body.notes !== undefined, body.notes ? body.notes : null],
  );

  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  res.status(204).end();
});

tasksRouter.delete('/:id', async (req, res) => {
  const user = authed(req);
  const { task, list } = await taskAccess(param(req, 'id'), user.id, 'editor');

  // Soft delete — the completions behind it are what the stats are made of.
  await query('UPDATE tasks SET archived_at = now() WHERE id = $1', [task.id]);
  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  res.status(204).end();
});

/* ── Reordering ──────────────────────────────────────────────────────────── */

/**
 * The slot is named by the tasks either side of it, never by a position — the
 * arithmetic is the server's job, so two clients dragging from stale views
 * can't invent overlapping floats between them.
 */
const moveTaskSchema = z.object({
  after: z.uuid().nullish(),
  before: z.uuid().nullish(),
});

/** What each refusal from `planMove` is worth over HTTP. */
function moveError(refusal: MoveRefusal): HttpError {
  switch (refusal) {
    case 'no_target':
      return new HttpError(
        400,
        'Say where the task should go: before or after another one',
        'invalid_request',
      );
    case 'self':
      return new HttpError(400, 'A task cannot be moved relative to itself', 'invalid_request');
    case 'unknown_task':
      // Not a 400. A task id belonging to a list the caller can't see must look
      // exactly like one that was never real.
      return notFound('That task');
    case 'stale_order':
      return new HttpError(
        409,
        'The list changed while you were dragging — reload and try again',
        'stale_order',
      );
  }
}

tasksRouter.post('/:id/move', async (req, res) => {
  const user = authed(req);
  const { task, list, role } = await taskAccess(param(req, 'id'), user.id, 'editor');
  const body = moveTaskSchema.parse(req.body);

  await transaction(async (client) => {
    // FOR UPDATE holds the list's tasks for the rest of the transaction. Two
    // people dragging at once would otherwise both plan against the same
    // snapshot and could pick the same midpoint. Ordered exactly as the read
    // path orders them, so the plan is made against what the client saw.
    const { rows } = await client.query<OrderedTask>(
      `SELECT id, position FROM tasks
        WHERE list_id = $1 AND archived_at IS NULL
        ORDER BY position, created_at
        FOR UPDATE`,
      [list.id],
    );

    const outcome = planMove(rows, task.id, body);
    // Thrown inside the transaction so it rolls back — a refused move must
    // leave every position exactly as it found them.
    if (!outcome.ok) throw moveError(outcome.refusal);

    // One statement whether that's a single row or a whole renumbering, so the
    // list is never briefly half-renumbered to a concurrent reader.
    await client.query(
      `UPDATE tasks SET position = moved.position
         FROM unnest($1::uuid[], $2::double precision[]) AS moved(id, position)
        WHERE tasks.id = moved.id`,
      [
        outcome.plan.writes.map((write) => write.id),
        outcome.plan.writes.map((write) => write.position),
      ],
    );
  });

  await broadcast(list.id, { type: 'task.changed', listId: list.id }, user.id);
  // The whole list comes back because a renumbering rewrites every position,
  // and a client holding the old ones would drag against a stale order.
  res.json(await listDetail(list, role));
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
