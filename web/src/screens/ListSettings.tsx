import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LIST_COLORS, LIST_EMOJI, type Cadence, type UpdateListBody, type Weekday } from '@tally/shared';
import { api } from '../lib/api';
import { useData } from '../lib/store';
import { cadenceLabel, resetPreview } from '../lib/format';
import { ChevronIcon, ListSkeleton, ScreenHeader } from '../components/ui';

const CADENCES: [Cadence, string][] = [
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['every_n_days', 'Every N days'],
  ['none', 'Never'],
];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** A short list of zones plus whatever this device is in, so the picker isn't 400 rows long. */
function timezoneOptions(current: string): string[] {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const common = [
    'Europe/London',
    'Europe/Dublin',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Australia/Sydney',
    'Asia/Tokyo',
    'Asia/Singapore',
    'UTC',
  ];
  return [...new Set([current, local, ...common])];
}

export function ListSettings() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { getList, loadList, setList, dropList } = useData();
  const list = getList(id);

  const [draft, setDraft] = useState<UpdateListBody>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void loadList(id);
  }, [id, loadList]);

  if (!list) return <ListSkeleton />;

  const value = { ...list, ...draft };
  const dirty = Object.keys(draft).length > 0;
  // Changing either of these moves the period boundary, so today's ticks drop
  // out of view. The rows survive against the old key, but people need warning.
  const periodMoving = draft.timezone !== undefined || draft.resetHour !== undefined || draft.cadence !== undefined;

  const set = (patch: UpdateListBody) => setDraft((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setList(await api.updateList(list.id, draft));
      setDraft({});
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    await api.deleteList(list.id);
    dropList(list.id);
    navigate('/');
  };

  return (
    <div className="safe-top h-full overflow-y-auto px-5 pb-12">
      <ScreenHeader title="List settings" back={`/l/${list.id}`} />

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="name">
            Name
          </label>
          <input
            id="name"
            className="field"
            value={value.name ?? ''}
            maxLength={80}
            onChange={(event) => set({ name: event.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Emoji</span>
          <div className="flex flex-wrap gap-2">
            {LIST_EMOJI.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => set({ emoji: option })}
                aria-pressed={value.emoji === option}
                className={`size-12 rounded-2xl text-[22px] ${
                  value.emoji === option ? 'border-[1.5px] border-accent bg-tint' : 'border border-divider bg-surface'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Colour</span>
          <div className="flex gap-2.5">
            {LIST_COLORS.map((color) => (
              <button
                key={color.id}
                type="button"
                aria-label={color.label}
                aria-pressed={value.color === color.hex}
                onClick={() => set({ color: color.hex })}
                className={`size-11 rounded-full border-[3px] ${
                  value.color === color.hex ? 'border-ink' : 'border-transparent'
                }`}
                style={{ background: color.hex }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="timezone">
            Timezone
          </label>
          <div className="relative">
            <select
              id="timezone"
              className="field appearance-none pr-10"
              value={value.timezone}
              onChange={(event) => set({ timezone: event.target.value })}
            >
              {timezoneOptions(list.timezone).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-muted">
              <ChevronIcon />
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted">Repeats</span>
          <div className="flex flex-wrap gap-2">
            {CADENCES.map(([cadence, label]) => (
              <button
                key={cadence}
                type="button"
                onClick={() => set({ cadence })}
                aria-pressed={value.cadence === cadence}
                className={`tap rounded-xl px-4 text-sm ${
                  value.cadence === cadence
                    ? 'border-[1.5px] border-accent bg-tint font-semibold text-accent-ink'
                    : 'border border-divider bg-surface font-medium'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {value.cadence === 'every_n_days' && (
            <div className="mt-1 flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer days"
                onClick={() => set({ cadenceIntervalDays: Math.max(2, (value.cadenceIntervalDays ?? 3) - 1) })}
                className="size-11 rounded-xl border border-divider bg-surface text-xl"
              >
                −
              </button>
              <span className="min-w-24 text-center font-semibold">every {value.cadenceIntervalDays} days</span>
              <button
                type="button"
                aria-label="More days"
                onClick={() => set({ cadenceIntervalDays: Math.min(365, (value.cadenceIntervalDays ?? 3) + 1) })}
                className="size-11 rounded-xl border border-divider bg-surface text-xl"
              >
                +
              </button>
            </div>
          )}

          {value.cadence === 'weekly' && (
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAYS.map((day, index) => (
                <button
                  key={day}
                  type="button"
                  onClick={() => set({ weekStart: (index + 1) as Weekday })}
                  aria-pressed={value.weekStart === index + 1}
                  className={`tap rounded-xl px-3 text-[13px] ${
                    value.weekStart === index + 1
                      ? 'border-[1.5px] border-accent bg-tint font-semibold text-accent-ink'
                      : 'border border-divider bg-surface'
                  }`}
                >
                  {day.slice(0, 3)}
                </button>
              ))}
            </div>
          )}
        </div>

        {value.cadence !== 'none' && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted">Reset hour</span>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Earlier"
                onClick={() => set({ resetHour: ((value.resetHour ?? 4) + 23) % 24 })}
                className="size-11 rounded-xl border border-divider bg-surface text-xl"
              >
                −
              </button>
              <span className="min-w-24 text-center text-xl font-semibold">
                {String(value.resetHour ?? 4).padStart(2, '0')}:00
              </span>
              <button
                type="button"
                aria-label="Later"
                onClick={() => set({ resetHour: ((value.resetHour ?? 4) + 1) % 24 })}
                className="size-11 rounded-xl border border-divider bg-surface text-xl"
              >
                +
              </button>
            </div>
            <p className="text-sm leading-relaxed text-muted text-pretty">{resetPreview(value.resetHour ?? 4)}</p>
          </div>
        )}

        <p className="rounded-xl bg-tint2 px-3.5 py-3 text-xs leading-relaxed text-muted text-pretty">
          This list currently reads as <span className="font-medium text-ink">{cadenceLabel(value)}</span>.
        </p>

        {periodMoving && (
          <p role="status" className="rounded-xl bg-tint px-3.5 py-3 text-xs leading-relaxed text-accent-ink text-pretty">
            Changing the timezone, cadence or reset hour starts a fresh period — today&apos;s ticks stay
            in the history, but the list will look unticked.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <button type="button" onClick={() => void save()} disabled={!dirty || saving} className="btn btn-primary">
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>

        <div className="mt-2 flex flex-col gap-2 border-t border-divider pt-5">
          <span className="text-xs font-medium text-danger">Danger zone</span>
          {confirmDelete ? (
            <>
              <button type="button" onClick={() => void remove()} className="btn border border-danger text-[15px] text-danger">
                Yes, delete {list.name}
              </button>
              <button type="button" onClick={() => setConfirmDelete(false)} className="tap text-sm text-muted">
                Keep it
              </button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="btn border border-danger text-[15px] text-danger">
              Delete this list
            </button>
          )}
          <p className="text-xs leading-snug text-muted">
            Removes it for all {list.members.length} member{list.members.length === 1 ? '' : 's'}. This
            can&apos;t be undone.
          </p>
        </div>
      </div>
    </div>
  );
}
