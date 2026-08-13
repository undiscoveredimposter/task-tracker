import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DateTime } from 'luxon';
import { currentPeriodKey, describeCadence, periodAt, periodsBack } from '../src/periods.ts';
import type { PeriodSchedule } from '../src/periods.ts';

const base: PeriodSchedule = {
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'Europe/London',
  resetHour: 4,
};

const at = (iso: string, zone = 'Europe/London') => DateTime.fromISO(iso, { zone });

describe('daily periods', () => {
  it('puts a late-night tick in the day that just ended', () => {
    // 00:30 on the 14th, with a 4am reset, is still "the 13th" as far as the
    // list is concerned — the whole reason resetHour defaults to 4.
    assert.equal(currentPeriodKey(base, at('2026-08-14T00:30')), 'd:2026-08-13');
    assert.equal(currentPeriodKey(base, at('2026-08-13T23:59')), 'd:2026-08-13');
  });

  it('rolls over exactly at the reset hour, not before', () => {
    assert.equal(currentPeriodKey(base, at('2026-08-14T03:59')), 'd:2026-08-13');
    assert.equal(currentPeriodKey(base, at('2026-08-14T04:00')), 'd:2026-08-14');
  });

  it('honours a midnight reset when asked for one', () => {
    const midnight = { ...base, resetHour: 0 };
    assert.equal(currentPeriodKey(midnight, at('2026-08-13T23:59')), 'd:2026-08-13');
    assert.equal(currentPeriodKey(midnight, at('2026-08-14T00:00')), 'd:2026-08-14');
  });

  it('reports the instant the list will untick', () => {
    const period = periodAt(base, at('2026-08-13T09:00'));
    assert.equal(period.start.toISO(), at('2026-08-13T04:00').toISO());
    assert.equal(period.end?.toISO(), at('2026-08-14T04:00').toISO());
  });

  it('gives two people in different timezones the same key for the same list', () => {
    // The list's timezone decides, not the viewer's — otherwise a shared list
    // shows different tick states to different people.
    const instant = DateTime.fromISO('2026-08-13T23:00Z');
    assert.equal(currentPeriodKey(base, instant), currentPeriodKey(base, instant.setZone('Asia/Tokyo')));
  });

  it('separates lists that genuinely live in different timezones', () => {
    const instant = DateTime.fromISO('2026-08-14T02:00Z');
    const london = currentPeriodKey(base, instant);
    const auckland = currentPeriodKey({ ...base, timezone: 'Pacific/Auckland' }, instant);
    assert.notEqual(london, auckland);
  });

  it('falls back to UTC rather than the system zone for an unknown timezone', () => {
    const key = currentPeriodKey({ ...base, timezone: 'Mars/Olympus' }, at('2026-08-13T12:00', 'UTC'));
    assert.equal(key, 'd:2026-08-13');
  });
});

describe('daylight saving', () => {
  // Europe/London springs forward on 2026-03-29 and falls back on 2026-10-25.
  it('advances exactly one period per day across the spring-forward', () => {
    const keys = ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'].map((day) =>
      currentPeriodKey(base, at(`${day}T12:00`)),
    );
    assert.deepEqual(keys, [
      'd:2026-03-27',
      'd:2026-03-28',
      'd:2026-03-29',
      'd:2026-03-30',
      'd:2026-03-31',
    ]);
  });

  const elapsedHours = (period: { start: DateTime; end: DateTime | null }) =>
    (period.end!.toMillis() - period.start.toMillis()) / 3_600_000;

  it('holds the reset at 4am wall-clock, making the spring period 23 hours long', () => {
    // The clocks jump at 01:00 on the 29th. With a 4am reset that instant still
    // belongs to the 28th, so it is *that* period which loses an hour — the one
    // starting on the 29th is an ordinary 24 hours.
    const shortened = periodAt(base, at('2026-03-29T00:30'));
    assert.equal(shortened.key, 'd:2026-03-28');
    assert.equal(shortened.start.hour, 4);
    assert.equal(shortened.end?.hour, 4);
    assert.equal(elapsedHours(shortened), 23);
    assert.equal(elapsedHours(periodAt(base, at('2026-03-29T12:00'))), 24);
  });

  it('makes the autumn period 25 hours without duplicating a key', () => {
    const lengthened = periodAt(base, at('2026-10-25T00:30'));
    assert.equal(lengthened.key, 'd:2026-10-24');
    assert.equal(lengthened.start.hour, 4);
    assert.equal(lengthened.end?.hour, 4);
    assert.equal(elapsedHours(lengthened), 25);
    assert.notEqual(currentPeriodKey(base, at('2026-10-25T12:00')), lengthened.key);
  });
});

describe('weekly periods', () => {
  const weekly: PeriodSchedule = { ...base, cadence: 'weekly' };

  it('keys a week by the date it starts', () => {
    // 2026-08-13 is a Thursday; the Monday of that week is the 10th.
    assert.equal(currentPeriodKey(weekly, at('2026-08-13T12:00')), 'w:2026-08-10');
    assert.equal(currentPeriodKey(weekly, at('2026-08-16T23:00')), 'w:2026-08-10');
    assert.equal(currentPeriodKey(weekly, at('2026-08-17T04:00')), 'w:2026-08-17');
  });

  it('respects a Sunday week start', () => {
    const sunday: PeriodSchedule = { ...weekly, weekStart: 7 };
    assert.equal(currentPeriodKey(sunday, at('2026-08-13T12:00')), 'w:2026-08-09');
    assert.equal(currentPeriodKey(sunday, at('2026-08-09T05:00')), 'w:2026-08-09');
    assert.equal(currentPeriodKey(sunday, at('2026-08-09T03:00')), 'w:2026-08-02');
  });

  it('runs a full week', () => {
    const period = periodAt(weekly, at('2026-08-13T12:00'));
    assert.equal(period.end!.diff(period.start, 'days').days, 7);
  });
});

describe('monthly periods', () => {
  const monthly: PeriodSchedule = { ...base, cadence: 'monthly' };

  it('keys by year and month', () => {
    assert.equal(currentPeriodKey(monthly, at('2026-08-13T12:00')), 'm:2026-08');
  });

  it('treats the small hours of the 1st as the previous month', () => {
    assert.equal(currentPeriodKey(monthly, at('2026-09-01T02:00')), 'm:2026-08');
    assert.equal(currentPeriodKey(monthly, at('2026-09-01T04:00')), 'm:2026-09');
  });

  it('handles February in a leap year', () => {
    assert.equal(currentPeriodKey(monthly, at('2028-02-29T12:00')), 'm:2028-02');
    assert.equal(currentPeriodKey(monthly, at('2028-03-01T02:00')), 'm:2028-02');
  });
});

describe('every N days', () => {
  const every3: PeriodSchedule = {
    ...base,
    cadence: 'every_n_days',
    cadenceIntervalDays: 3,
    cadenceAnchor: '2026-08-10',
  };

  it('holds the same key for the whole cycle and moves on after it', () => {
    assert.equal(currentPeriodKey(every3, at('2026-08-10T12:00')), 'n3:0');
    assert.equal(currentPeriodKey(every3, at('2026-08-12T23:00')), 'n3:0');
    assert.equal(currentPeriodKey(every3, at('2026-08-13T04:00')), 'n3:1');
    assert.equal(currentPeriodKey(every3, at('2026-08-16T04:00')), 'n3:2');
  });

  it('counts backwards from the anchor without collapsing periods', () => {
    assert.equal(currentPeriodKey(every3, at('2026-08-09T12:00')), 'n3:-1');
    assert.equal(currentPeriodKey(every3, at('2026-08-07T12:00')), 'n3:-1');
    assert.equal(currentPeriodKey(every3, at('2026-08-06T12:00')), 'n3:-2');
  });

  it('does not slip a cycle across a DST boundary', () => {
    // The naive floor(diff / n) drifts here: the raw diff is 23.958 days, not 24.
    const spanning: PeriodSchedule = { ...every3, cadenceAnchor: '2026-03-01' };
    assert.equal(currentPeriodKey(spanning, at('2026-03-30T12:00')), 'n3:9');
    assert.equal(currentPeriodKey(spanning, at('2026-04-02T12:00')), 'n3:10');
  });

  it('spans exactly N days', () => {
    const period = periodAt(every3, at('2026-08-13T12:00'));
    assert.equal(period.end!.diff(period.start, 'days').days, 3);
  });
});

describe('lists that never reset', () => {
  const never: PeriodSchedule = { ...base, cadence: 'none' };

  it('uses one key forever', () => {
    assert.equal(currentPeriodKey(never, at('2026-08-13T12:00')), 'static');
    assert.equal(currentPeriodKey(never, at('2031-01-01T12:00')), 'static');
  });

  it('has no end, so nothing ever unticks', () => {
    assert.equal(periodAt(never, at('2026-08-13T12:00')).end, null);
  });
});

describe('periodsBack', () => {
  it('walks back without repeating or skipping a period', () => {
    const periods = periodsBack(base, 5, at('2026-08-13T12:00'));
    assert.deepEqual(
      periods.map((period) => period.key),
      ['d:2026-08-09', 'd:2026-08-10', 'd:2026-08-11', 'd:2026-08-12', 'd:2026-08-13'],
    );
  });

  it('stays correct stepping back over the spring-forward', () => {
    const keys = periodsBack(base, 4, at('2026-03-30T12:00')).map((period) => period.key);
    assert.deepEqual(keys, ['d:2026-03-27', 'd:2026-03-28', 'd:2026-03-29', 'd:2026-03-30']);
  });

  it('walks back by month, not by day, for a monthly list', () => {
    const monthly: PeriodSchedule = { ...base, cadence: 'monthly' };
    const keys = periodsBack(monthly, 3, at('2026-01-15T12:00')).map((period) => period.key);
    assert.deepEqual(keys, ['m:2025-11', 'm:2025-12', 'm:2026-01']);
  });

  it('collapses to a single entry for a list that never resets', () => {
    assert.equal(periodsBack({ ...base, cadence: 'none' }, 30).length, 1);
  });
});

describe('describeCadence', () => {
  it('speaks plainly about when the list clears', () => {
    assert.equal(describeCadence(base), 'Daily · resets 4:00am');
    assert.equal(describeCadence({ ...base, resetHour: 0 }), 'Daily · resets midnight');
    assert.equal(describeCadence({ ...base, resetHour: 17 }), 'Daily · resets 5:00pm');
    assert.equal(describeCadence({ ...base, cadence: 'weekly' }), 'Weekly · resets Monday 4:00am');
    assert.equal(describeCadence({ ...base, cadence: 'every_n_days' }), 'Every 3 days · resets 4:00am');
    assert.equal(describeCadence({ ...base, cadence: 'none' }), 'Never resets');
  });
});
