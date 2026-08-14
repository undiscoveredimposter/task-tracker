-- Make the task order total, and give reordering room to work.
--
-- `tasks.position` is a float so a task can be dropped between two others with
-- one UPDATE. That only works if neighbours actually have different positions.
-- Rows created before this migration could share one: the column defaults to 0,
-- and until now nothing but the insert path ever set it. Where positions tie,
-- the displayed order fell back to created_at — and where that tied too, to
-- whatever the planner returned.
--
-- So: renumber every list's tasks 1, 2, 3 … in the order they are already shown
-- (position, then created_at, then id), which changes no list's visible order
-- and leaves a gap of 1 between every pair for POST /api/tasks/:id/move to
-- bisect. Archived tasks are numbered alongside the live ones so a task that
-- comes back doesn't land on top of another.

UPDATE tasks t
   SET position = ordered.rank
  FROM (
    SELECT id,
           row_number() OVER (PARTITION BY list_id ORDER BY position, created_at, id) AS rank
      FROM tasks
  ) AS ordered
 WHERE ordered.id = t.id
   AND t.position IS DISTINCT FROM ordered.rank;

-- Matches the ORDER BY that every read of tasks now uses, so the list detail
-- query and the FOR UPDATE the move endpoint takes can both be served from it.
CREATE INDEX tasks_list_order_idx ON tasks (list_id, position, created_at, id)
  WHERE archived_at IS NULL;
