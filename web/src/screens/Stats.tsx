import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Stats as StatsDto } from '@tally/shared';
import { api } from '../lib/api';
import { useData } from '../lib/store';
import { Avatar, ListSkeleton, ScreenHeader } from '../components/ui';

const TINTS = ['bg-tint', 'bg-tint2', 'bg-tint3'];

/** What a streak of N periods means in words, for the cadence in question. */
function streakLabel(streak: number, cadence: string): string {
  const unit = cadence === 'weekly' ? 'week' : cadence === 'monthly' ? 'month' : 'day';
  return `${streak} ${unit}${streak === 1 ? '' : 's'}`;
}

export function Stats() {
  const { id = '' } = useParams();
  const { getList, loadList } = useData();
  const list = getList(id);

  const [window, setWindow] = useState(7);
  const [stats, setStats] = useState<StatsDto | null>(null);

  useEffect(() => {
    void loadList(id);
  }, [id, loadList]);

  useEffect(() => {
    api.stats(id, window).then(setStats).catch(() => setStats(null));
  }, [id, window]);

  if (!list) return <ListSkeleton />;

  const percent = stats && stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;
  const most = stats ? Math.max(1, ...stats.people.map((person) => person.count)) : 1;

  return (
    <div className="safe-top h-full overflow-y-auto px-5 pb-12">
      <ScreenHeader title="How it's going" back={`/l/${list.id}`} />

      <div className="flex flex-col gap-4">
        <div className="card rounded-2xl p-[18px]">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">
              {stats ? streakLabel(stats.streak, list.cadence) : '—'}
            </span>
            <span className="text-sm text-muted">running</span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted text-pretty">
            {!stats || stats.streak === 0
              ? 'No run going just now. Clear everything before the next reset and it starts again.'
              : `Everything on ${list.name} has been done, every time, for ${streakLabel(stats.streak, list.cadence)}. Nice one, all of you.`}
          </p>
        </div>

        <div className="card rounded-2xl p-[18px]">
          <div className="mb-3.5 flex items-center justify-between">
            <span className="text-[15px] font-semibold">Together</span>
            <span className="inline-flex overflow-hidden rounded-lg border border-divider">
              {[7, 30].map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setWindow(option)}
                  aria-pressed={window === option}
                  className={`min-h-9 px-3.5 text-[13px] font-medium ${
                    window === option ? 'bg-tint text-accent-ink' : 'text-muted'
                  }`}
                >
                  {option} days
                </button>
              ))}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">
              {stats ? `${stats.done} of ${stats.total}` : '—'}
            </span>
            <span className="text-sm text-muted">tasks done · {percent}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-track">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className="card rounded-2xl p-[18px]">
          <span className="text-[15px] font-semibold">Who got to what</span>
          <div className="mt-3.5 flex flex-col gap-3.5">
            {stats?.people.map((person, index) => (
              <div key={person.id} className="flex items-center gap-3">
                <Avatar user={person} index={index} size={32} />
                <div className="flex flex-1 flex-col gap-1.5">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{person.displayName}</span>
                    <span className="text-muted">{person.count} tasks</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-track">
                    <div
                      className={`h-full rounded-full transition-[width] duration-300 ${TINTS[index % TINTS.length]}`}
                      style={{ width: `${Math.round((person.count / most) * 100)}%`, background: 'var(--t-accent)', opacity: 0.75 }}
                    />
                  </div>
                </div>
              </div>
            ))}
            {stats?.people.length === 0 && <p className="text-sm text-muted">Nobody has ticked anything yet.</p>}
          </div>
          <p className="mt-3.5 text-xs leading-relaxed text-muted text-pretty">
            Counts, not scores — some tasks are bigger than others, and that&apos;s fine.
          </p>
        </div>
      </div>
    </div>
  );
}
