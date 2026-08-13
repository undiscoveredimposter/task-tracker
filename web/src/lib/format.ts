import type { Completion, ListSchedule, ListSummary } from '@tally/shared';

/** Everything the UI says about time, in one place so the wording stays consistent. */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** "4:00am", "midnight", "noon" — how a reset hour reads in a sentence. */
export function hourLabel(hour: number): string {
  if (hour === 0) return 'midnight';
  if (hour === 12) return 'noon';
  return hour < 12 ? `${hour}:00am` : `${hour - 12}:00pm`;
}

/**
 * Countdown for the list header and cards. Coarse on purpose: nobody needs
 * seconds, and a value that changes every second is a value you stop reading.
 */
export function resetsInLabel(resetsAt: string | null, now: Date = new Date()): string {
  if (!resetsAt) return 'never resets';

  const remaining = new Date(resetsAt).getTime() - now.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) return 'resetting now';

  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)}m`;

  const hours = Math.floor(remaining / 3_600_000);
  if (hours < 48) return `resets in ${hours}h`;

  return `resets in ${Math.round(remaining / 86_400_000)} days`;
}

/**
 * The time a task was ticked, shown in the *list's* timezone rather than the
 * reader's. Everyone sharing a list then sees the same thing, and a tick that
 * counted for yesterday doesn't display as today.
 */
export function timeOfDay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(date);

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('hour')}:${value('minute')}${value('dayPeriod').toLowerCase().replace(/\s/g, '')}`;
}

/** "Sam · 7:42am", or "You · 8:02am" when it was the reader. */
export function whoDidIt(completion: Completion, meId: string | null, timeZone: string): string {
  const name = completion.by.id === meId ? 'You' : completion.by.displayName;
  return `${name} · ${timeOfDay(completion.at, timeZone)}`;
}

/** First character of a name, for the avatar circles. Emoji-safe. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  // Iterating the string yields whole code points, so an emoji stays intact
  // instead of being cut in half into a replacement character.
  return [...trimmed][0]?.toUpperCase() ?? '?';
}

/** "Daily · resets 4:00am" — the subtitle on every list card. */
export function cadenceLabel(schedule: ListSchedule): string {
  const at = hourLabel(schedule.resetHour);
  switch (schedule.cadence) {
    case 'none':
      return 'Never resets';
    case 'daily':
      return `Daily · resets ${at}`;
    case 'weekly':
      return `Weekly · resets ${DAY_NAMES[schedule.weekStart - 1] ?? 'Monday'} ${at}`;
    case 'monthly':
      return `Monthly · resets on the 1st at ${at}`;
    case 'every_n_days':
      return `Every ${schedule.cadenceIntervalDays} days · resets ${at}`;
  }
}

/** "daily", "every 3 days" — the cadence alone, where a whole sentence won't fit. */
export function cadenceShort(schedule: Pick<ListSchedule, 'cadence' | 'cadenceIntervalDays'>): string {
  switch (schedule.cadence) {
    case 'none':
      return 'never resets';
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'monthly':
      return 'monthly';
    case 'every_n_days':
      return `every ${schedule.cadenceIntervalDays} days`;
  }
}

/** "3 of 5 · daily" — a whole list on one line, for the desktop sidebar. */
export function listSummaryLine(
  list: Pick<ListSummary, 'doneCount' | 'taskCount' | 'cadence' | 'cadenceIntervalDays'>,
): string {
  // "0 of 0" reads like a failure rather than an empty list.
  const progress = list.taskCount === 0 ? 'No tasks' : `${list.doneCount} of ${list.taskCount}`;
  return `${progress} · ${cadenceShort(list)}`;
}

/**
 * The settings-screen explainer. The reset hour is the least obvious setting in
 * the app, so it gets a full sentence rather than a tooltip.
 */
export function resetPreview(hour: number): string {
  if (hour === 0) {
    return 'Resets at midnight — the list starts fresh exactly when the date changes.';
  }
  const at = hourLabel(hour);
  return `Resets at ${at} — tasks done between midnight and ${at} still count for the previous day.`;
}
