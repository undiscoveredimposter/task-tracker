import { DateTime } from 'luxon';
import type { ListSchedule } from '@tally/shared';

/**
 * Period keys — how a list resets without anything ever running on a schedule.
 *
 * A completion is stored against the key of the period it belongs to. "Is this
 * task done?" means "is there a completion row for the key of the period we are
 * in right now?", so when the clock rolls past the reset hour the current key
 * changes and every task is implicitly outstanding again. Nothing is deleted,
 * nothing has to run at 4am, and the history stays intact for stats.
 */

export interface PeriodSchedule extends ListSchedule {
  /** `YYYY-MM-DD`; the fixed point an `every_n_days` cycle counts from. */
  cadenceAnchor?: string;
}

export interface Period {
  key: string;
  /** Instant the period began (inclusive). */
  start: DateTime;
  /** Instant it ends and the list unticks (exclusive). Null when cadence is `none`. */
  end: DateTime | null;
}

const STATIC_KEY = 'static';

/** Luxon falls back to the system zone for an unknown name; refuse that quietly-wrong behaviour. */
function zoneOf(schedule: PeriodSchedule): string {
  return DateTime.local().setZone(schedule.timezone).isValid ? schedule.timezone : 'UTC';
}

/**
 * The calendar date a moment belongs to, once the reset hour is taken into
 * account. Subtracting the reset hour before reading the date is the whole
 * trick: at 00:30 with a 4am reset, this still returns yesterday, so a
 * late-night tick counts for the day that just ended.
 */
function logicalDate(schedule: PeriodSchedule, at: DateTime): DateTime {
  return at.setZone(zoneOf(schedule)).minus({ hours: schedule.resetHour }).startOf('day');
}

/** Wall-clock reset time on a given logical date — `set` rather than `plus` so DST can't drift it. */
function atResetHour(schedule: PeriodSchedule, date: DateTime): DateTime {
  return date.set({ hour: schedule.resetHour, minute: 0, second: 0, millisecond: 0 });
}

/** The period containing `at`. */
export function periodAt(schedule: PeriodSchedule, at: DateTime = DateTime.utc()): Period {
  const zone = zoneOf(schedule);
  const date = logicalDate(schedule, at);

  switch (schedule.cadence) {
    case 'none':
      return { key: STATIC_KEY, start: DateTime.fromMillis(0, { zone }), end: null };

    case 'daily': {
      const start = atResetHour(schedule, date);
      return { key: `d:${date.toFormat('yyyy-MM-dd')}`, start, end: start.plus({ days: 1 }) };
    }

    case 'weekly': {
      // Luxon's weekday is 1 (Mon) … 7 (Sun), the same basis as week_start.
      const offset = (date.weekday - schedule.weekStart + 7) % 7;
      const weekStart = date.minus({ days: offset });
      const start = atResetHour(schedule, weekStart);
      return { key: `w:${weekStart.toFormat('yyyy-MM-dd')}`, start, end: start.plus({ weeks: 1 }) };
    }

    case 'monthly': {
      const monthStart = date.startOf('month');
      const start = atResetHour(schedule, monthStart);
      return { key: `m:${date.toFormat('yyyy-MM')}`, start, end: start.plus({ months: 1 }) };
    }

    case 'every_n_days': {
      const n = Math.max(2, Math.round(schedule.cadenceIntervalDays));
      const anchor = DateTime.fromISO(schedule.cadenceAnchor ?? '1970-01-01', { zone }).startOf('day');
      const base = anchor.isValid ? anchor : DateTime.fromISO('1970-01-01', { zone });
      // Round rather than truncate: a DST shift makes the diff 23.958 or 24.042
      // days, and Math.floor on the raw value would slip a period at the edge.
      const daysSince = Math.round(date.diff(base, 'days').days);
      const index = Math.floor(daysSince / n);
      const periodStart = base.plus({ days: index * n });
      const start = atResetHour(schedule, periodStart);
      return { key: `n${n}:${index}`, start, end: start.plus({ days: n }) };
    }
  }
}

/** Convenience for callers that only need the identifier. */
export function currentPeriodKey(schedule: PeriodSchedule, at: DateTime = DateTime.utc()): string {
  return periodAt(schedule, at).key;
}

/**
 * The `count` most recent periods, oldest first, ending with the one containing
 * `at`. Used by stats, which needs to know which keys to count over.
 */
export function periodsBack(
  schedule: PeriodSchedule,
  count: number,
  at: DateTime = DateTime.utc(),
): Period[] {
  if (schedule.cadence === 'none') return [periodAt(schedule, at)];

  const periods: Period[] = [];
  let cursor = at;
  for (let i = 0; i < count; i++) {
    const period = periodAt(schedule, cursor);
    periods.unshift(period);
    // Step just inside the previous period rather than onto its boundary.
    cursor = period.start.minus({ milliseconds: 1 });
  }
  return periods;
}

/** Human-readable cadence, e.g. "Daily · resets 4:00am". Kept next to the maths it describes. */
export function describeCadence(schedule: PeriodSchedule): string {
  const hour = schedule.resetHour;
  const label =
    hour === 0 ? 'midnight' : hour === 12 ? 'noon' : hour < 12 ? `${hour}:00am` : `${hour - 12}:00pm`;

  switch (schedule.cadence) {
    case 'none':
      return 'Never resets';
    case 'daily':
      return `Daily · resets ${label}`;
    case 'weekly': {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      return `Weekly · resets ${days[schedule.weekStart - 1] ?? 'Monday'} ${label}`;
    }
    case 'monthly':
      return `Monthly · resets on the 1st at ${label}`;
    case 'every_n_days':
      return `Every ${schedule.cadenceIntervalDays} days · resets ${label}`;
  }
}
