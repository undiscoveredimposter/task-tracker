import { describe, expect, it } from 'vitest';
import type { ListSchedule } from '@tally/shared';
import {
  cadenceLabel,
  initialOf,
  offlineLabel,
  resetPreview,
  resetsInLabel,
  savedAgoLabel,
  timeOfDay,
  whoDidIt,
} from './format';

const schedule: ListSchedule = {
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'Europe/London',
  resetHour: 4,
};

const now = new Date('2026-08-13T08:00:00Z');
const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();

describe('resetsInLabel', () => {
  it('counts down in hours for the rest of today', () => {
    // The list screen header in the mockup reads "resets in 20h".
    expect(resetsInLabel(inHours(20), now)).toBe('resets in 20h');
  });

  it('switches to minutes in the last hour', () => {
    expect(resetsInLabel(inMinutes(45), now)).toBe('resets in 45m');
    expect(resetsInLabel(inMinutes(1), now)).toBe('resets in 1m');
  });

  it('switches to days beyond two, so a weekly list reads sensibly', () => {
    expect(resetsInLabel(inHours(24 * 4), now)).toBe('resets in 4 days');
    expect(resetsInLabel(inHours(24 * 2), now)).toBe('resets in 2 days');
    expect(resetsInLabel(inHours(47), now)).toBe('resets in 47h');
  });

  it('says days in the singular when there is one', () => {
    expect(resetsInLabel(inHours(24 * 2.9), now)).toBe('resets in 3 days');
  });

  it('handles the moment of the reset itself without going negative', () => {
    expect(resetsInLabel(inMinutes(0), now)).toBe('resetting now');
    expect(resetsInLabel(inMinutes(-5), now)).toBe('resetting now');
  });

  it('says so plainly when a list never resets', () => {
    expect(resetsInLabel(null, now)).toBe('never resets');
  });
});

describe('timeOfDay', () => {
  it('reads as a 12-hour clock in the list timezone', () => {
    // 06:42 UTC is 07:42 British Summer Time.
    expect(timeOfDay('2026-08-13T06:42:00Z', 'Europe/London')).toBe('7:42am');
  });

  it('gets noon and midnight the right way round', () => {
    expect(timeOfDay('2026-08-13T11:00:00Z', 'Europe/London')).toBe('12:00pm');
    expect(timeOfDay('2026-08-12T23:00:00Z', 'Europe/London')).toBe('12:00am');
  });

  it('shows the list timezone rather than the reader s own', () => {
    // Same instant, a list kept in Tokyo: everyone sharing sees one time.
    expect(timeOfDay('2026-08-13T06:42:00Z', 'Asia/Tokyo')).toBe('3:42pm');
  });

  it('pads the minutes', () => {
    expect(timeOfDay('2026-08-13T07:05:00Z', 'Europe/London')).toBe('8:05am');
  });
});

describe('whoDidIt', () => {
  const completion = {
    at: '2026-08-13T06:42:00Z',
    by: { id: 'sam', displayName: 'Sam', email: null, photoUrl: null },
  };

  it('names the person and the time, as the mockup does', () => {
    expect(whoDidIt(completion, 'alex', 'Europe/London')).toBe('Sam · 7:42am');
  });

  it('says "You" for your own ticks', () => {
    expect(whoDidIt(completion, 'sam', 'Europe/London')).toBe('You · 7:42am');
  });
});

describe('initialOf', () => {
  it('takes the first letter for an avatar', () => {
    expect(initialOf('Alex')).toBe('A');
    expect(initialOf('sam')).toBe('S');
  });

  it('falls back rather than rendering an empty circle', () => {
    expect(initialOf('')).toBe('?');
    expect(initialOf('  ')).toBe('?');
  });

  it('copes with a name that starts with an emoji', () => {
    expect(initialOf('🐈 Cat Sitter')).toBe('🐈');
  });
});

describe('cadenceLabel', () => {
  it('describes each cadence the way the list cards do', () => {
    expect(cadenceLabel(schedule)).toBe('Daily · resets 4:00am');
    expect(cadenceLabel({ ...schedule, cadence: 'weekly' })).toBe('Weekly · resets Monday 4:00am');
    expect(cadenceLabel({ ...schedule, cadence: 'monthly' })).toBe('Monthly · resets on the 1st at 4:00am');
    expect(cadenceLabel({ ...schedule, cadence: 'every_n_days' })).toBe('Every 3 days · resets 4:00am');
    expect(cadenceLabel({ ...schedule, cadence: 'none' })).toBe('Never resets');
  });

  it('says midnight and noon rather than 0:00 and 12:00', () => {
    expect(cadenceLabel({ ...schedule, resetHour: 0 })).toBe('Daily · resets midnight');
    expect(cadenceLabel({ ...schedule, resetHour: 12 })).toBe('Daily · resets noon');
    expect(cadenceLabel({ ...schedule, resetHour: 17 })).toBe('Daily · resets 5:00pm');
  });
});

describe('resetPreview', () => {
  it('explains in plain words what a 4am reset means', () => {
    expect(resetPreview(4)).toBe(
      'Resets at 4:00am — tasks done between midnight and 4:00am still count for the previous day.',
    );
  });

  it('drops the caveat at midnight, where there is nothing to explain', () => {
    expect(resetPreview(0)).toBe(
      'Resets at midnight — the list starts fresh exactly when the date changes.',
    );
  });
});

describe('savedAgoLabel', () => {
  const ago = (ms: number) => savedAgoLabel(now.getTime() - ms, now);

  it('stays vague for the last minute, where a number would be noise', () => {
    expect(ago(0)).toBe('a moment ago');
    expect(ago(30_000)).toBe('a moment ago');
  });

  it('counts minutes, then hours, then days', () => {
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(45 * 60_000)).toBe('45 minutes ago');
    expect(ago(3_600_000)).toBe('1 hour ago');
    expect(ago(5 * 3_600_000)).toBe('5 hours ago');
    expect(ago(26 * 3_600_000)).toBe('1 day ago');
    expect(ago(4 * 86_400_000)).toBe('4 days ago');
  });

  it('does not read the future when the device clock has drifted', () => {
    expect(ago(-90_000)).toBe('a moment ago');
  });
});

describe('offlineLabel', () => {
  const savedAt = now.getTime() - 3 * 3_600_000;

  it('says nothing at all when everything is current', () => {
    expect(offlineLabel({ online: true, pending: 0, savedAt }, now)).toBe('');
  });

  it('says the list is remembered rather than current', () => {
    expect(offlineLabel({ online: false, pending: 0, savedAt }, now)).toBe(
      'Offline — showing what was here 3 hours ago',
    );
  });

  it('counts what is still waiting alongside it', () => {
    expect(offlineLabel({ online: false, pending: 2, savedAt }, now)).toBe(
      'Offline — showing what was here 3 hours ago · 2 ticks waiting to sync',
    );
    expect(offlineLabel({ online: false, pending: 1, savedAt }, now)).toBe(
      'Offline — showing what was here 3 hours ago · 1 tick waiting to sync',
    );
  });

  it('falls back to the plain wording when nothing has been saved yet', () => {
    expect(offlineLabel({ online: false, pending: 0, savedAt: null }, now)).toBe(
      'Offline — you can still tick things off',
    );
    expect(offlineLabel({ online: false, pending: 3, savedAt: null }, now)).toBe(
      'Offline — 3 ticks waiting to sync',
    );
  });

  it('stops claiming to be offline once the queue is draining', () => {
    expect(offlineLabel({ online: true, pending: 2, savedAt }, now)).toBe('Syncing 2 ticks…');
    expect(offlineLabel({ online: true, pending: 1, savedAt }, now)).toBe('Syncing 1 tick…');
  });
});
