import type { DateTime } from 'luxon';
import type { Period } from './periods.js';

export interface StatsTask {
  id: string;
  createdAt: Date;
  /** Soft-delete time. The task still counts for periods it was alive during. */
  archivedAt: Date | null;
}

export interface StatsCompletion {
  taskId: string;
  periodKey: string;
  completedBy: string | null;
}

export interface StatsInput {
  /** Oldest first, ending with the period in progress. May be longer than `window`. */
  periods: Period[];
  /** How many of the most recent periods the totals cover. */
  window: number;
  tasks: StatsTask[];
  completions: StatsCompletion[];
  now: DateTime;
}

export interface StatsTotals {
  window: number;
  streak: number;
  done: number;
  total: number;
  perUser: Map<string, number>;
}

/**
 * Turns raw completion rows into the numbers behind the stats screen.
 *
 * Pure on purpose: the interesting parts — what counts as an opportunity, and
 * when a streak survives — are judgement calls worth testing directly rather
 * than through a database.
 */
export function summariseStats(input: StatsInput): StatsTotals {
  const { periods, window, tasks, completions, now } = input;

  const doneByPeriod = new Map<string, Set<string>>();
  for (const completion of completions) {
    let set = doneByPeriod.get(completion.periodKey);
    if (!set) doneByPeriod.set(completion.periodKey, (set = new Set()));
    set.add(completion.taskId);
  }

  /**
   * Tasks that actually existed during a period. Without this, adding a task
   * today would make every past day look like it was missed, and deleting one
   * would quietly rewrite history in the other direction.
   */
  const liveDuring = (period: Period): StatsTask[] =>
    tasks.filter((task) => {
      const existedByThen = !period.end || task.createdAt.getTime() < period.end.toMillis();
      const notYetArchived = !task.archivedAt || task.archivedAt.getTime() > period.start.toMillis();
      return existedByThen && notYetArchived;
    });

  const windowPeriods = periods.slice(-window);
  const windowKeys = new Set(windowPeriods.map((period) => period.key));

  let total = 0;
  let done = 0;
  for (const period of windowPeriods) {
    const live = liveDuring(period);
    const completed = doneByPeriod.get(period.key);
    total += live.length;
    if (completed) done += live.filter((task) => completed.has(task.id)).length;
  }

  // A streak counts back from the last period that has actually ended. The one
  // in progress isn't a miss just because the day isn't over yet.
  const finished = periods.filter((period) => period.end && period.end <= now);
  let streak = 0;
  for (let i = finished.length - 1; i >= 0; i--) {
    const period = finished[i]!;
    const live = liveDuring(period);
    const completed = doneByPeriod.get(period.key) ?? new Set<string>();
    // No tasks is not an achievement, so it ends the run rather than extending it.
    if (live.length === 0 || !live.every((task) => completed.has(task.id))) break;
    streak++;
  }

  const perUser = new Map<string, number>();
  for (const completion of completions) {
    if (!completion.completedBy || !windowKeys.has(completion.periodKey)) continue;
    perUser.set(completion.completedBy, (perUser.get(completion.completedBy) ?? 0) + 1);
  }

  return { window, streak, done, total, perUser };
}
