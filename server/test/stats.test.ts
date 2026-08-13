import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { summariseStats, type StatsTask } from '../src/stats.ts';
import { periodsBack, type PeriodSchedule } from '../src/periods.ts';

const daily: PeriodSchedule = {
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'Europe/London',
  resetHour: 4,
};

/** Mid-morning on Thursday 13 August 2026 — inside the d:2026-08-13 period. */
const now = DateTime.fromISO('2026-08-13T09:00', { zone: 'Europe/London' });

const task = (id: string, createdAt = '2026-01-01T00:00Z', archivedAt: string | null = null): StatsTask => ({
  id,
  createdAt: new Date(createdAt),
  archivedAt: archivedAt ? new Date(archivedAt) : null,
});

const done = (taskId: string, periodKey: string, completedBy: string | null = 'alex') => ({
  taskId,
  periodKey,
  completedBy,
});

/** The last `n` daily period keys ending with today's. */
const keys = (n: number) => periodsBack(daily, n, now).map((period) => period.key);

describe('summariseStats', () => {
  const twoTasks = [task('feed'), task('bins')];

  it('counts opportunities as tasks × periods in the window', () => {
    const stats = summariseStats({
      periods: periodsBack(daily, 7, now),
      window: 7,
      tasks: twoTasks,
      completions: [],
      now,
    });
    assert.equal(stats.total, 14);
    assert.equal(stats.done, 0);
  });

  it('counts only completions inside the window', () => {
    const [oldest, ...rest] = keys(8);
    const stats = summariseStats({
      periods: periodsBack(daily, 8, now),
      window: 7,
      tasks: twoTasks,
      completions: [done('feed', oldest!), done('feed', rest[0]!), done('bins', rest[1]!)],
      now,
    });
    // The window is the last 7 of the 8 periods, so the oldest tick is outside it.
    assert.equal(stats.total, 14);
    assert.equal(stats.done, 2);
  });

  it('does not blame a period for a task that did not exist yet', () => {
    // Added this morning: the previous six days had one task, not two.
    const stats = summariseStats({
      periods: periodsBack(daily, 7, now),
      window: 7,
      tasks: [task('feed'), task('bins', '2026-08-13T08:00Z')],
      completions: [],
      now,
    });
    assert.equal(stats.total, 8);
  });

  it('keeps a deleted task in the history it was part of', () => {
    // Archived on the 11th — it counts up to then and not after.
    const stats = summariseStats({
      periods: periodsBack(daily, 7, now),
      window: 7,
      tasks: [task('feed'), task('bins', '2026-01-01T00:00Z', '2026-08-11T09:00Z')],
      completions: [],
      now,
    });
    assert.ok(stats.total > 7 && stats.total < 14, `expected a partial count, got ${stats.total}`);
  });

  describe('streaks', () => {
    it('counts consecutive finished periods where everything got done', () => {
      const [d7, d6, d5, d4, d3, d2] = keys(7);
      const completions = [d7, d6, d5, d4, d3, d2].flatMap((key) => [
        done('feed', key!),
        done('bins', key!),
      ]);
      const stats = summariseStats({
        periods: periodsBack(daily, 7, now),
        window: 7,
        tasks: twoTasks,
        completions,
        now,
      });
      assert.equal(stats.streak, 6);
    });

    it('is not broken by today still being in progress', () => {
      // Yesterday and the day before are complete; today has one of two done.
      const all = keys(7);
      const today = all.at(-1)!;
      const finished = all.slice(0, -1);
      const completions = finished.flatMap((key) => [done('feed', key), done('bins', key)]);
      completions.push(done('feed', today));

      const stats = summariseStats({
        periods: periodsBack(daily, 7, now),
        window: 7,
        tasks: twoTasks,
        completions,
        now,
      });
      assert.equal(stats.streak, 6);
    });

    it('stops at the first period with something outstanding', () => {
      const all = keys(7);
      const finished = all.slice(0, -1);
      const completions = finished.flatMap((key) => [done('feed', key), done('bins', key)]);
      // Drop one tick three finished periods back.
      const missed = finished.at(-3)!;
      const pruned = completions.filter((c) => !(c.periodKey === missed && c.taskId === 'bins'));

      const stats = summariseStats({
        periods: periodsBack(daily, 7, now),
        window: 7,
        tasks: twoTasks,
        completions: pruned,
        now,
      });
      assert.equal(stats.streak, 2);
    });

    it('is zero when the most recent finished period was missed', () => {
      const stats = summariseStats({
        periods: periodsBack(daily, 7, now),
        window: 7,
        tasks: twoTasks,
        completions: [],
        now,
      });
      assert.equal(stats.streak, 0);
    });

    it('does not award a streak for periods with no tasks at all', () => {
      const stats = summariseStats({
        periods: periodsBack(daily, 7, now),
        window: 7,
        tasks: [task('feed', '2026-08-13T08:00Z')],
        completions: [],
        now,
      });
      assert.equal(stats.streak, 0);
    });
  });

  describe('per-person counts', () => {
    it('attributes ticks to whoever made them, within the window', () => {
      const [k1, k2, k3] = keys(3);
      const stats = summariseStats({
        periods: periodsBack(daily, 3, now),
        window: 3,
        tasks: twoTasks,
        completions: [
          done('feed', k1!, 'alex'),
          done('bins', k1!, 'sam'),
          done('feed', k2!, 'sam'),
          done('feed', k3!, 'jo'),
        ],
        now,
      });
      assert.equal(stats.perUser.get('alex'), 1);
      assert.equal(stats.perUser.get('sam'), 2);
      assert.equal(stats.perUser.get('jo'), 1);
    });

    it('ignores ticks from a since-deleted account rather than crashing', () => {
      const [k1] = keys(1);
      const stats = summariseStats({
        periods: periodsBack(daily, 1, now),
        window: 1,
        tasks: twoTasks,
        completions: [done('feed', k1!, null)],
        now,
      });
      assert.equal(stats.perUser.size, 0);
      assert.equal(stats.done, 1);
    });
  });

  it('treats a never-resetting list as a single period', () => {
    const never: PeriodSchedule = { ...daily, cadence: 'none' };
    const periods = periodsBack(never, 7, now);
    const stats = summariseStats({
      periods,
      window: 7,
      tasks: twoTasks,
      completions: [done('feed', 'static')],
      now,
    });
    assert.equal(stats.total, 2);
    assert.equal(stats.done, 1);
  });
});
