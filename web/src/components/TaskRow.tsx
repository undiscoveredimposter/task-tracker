import type { Task } from '@tally/shared';
import { taskRowLabel } from '../lib/a11y';
import { whoDidIt } from '../lib/format';
import { CheckIcon } from './ui';

interface TaskRowProps {
  task: Task;
  meId: string | null;
  timezone: string;
  onToggle: () => void;
  onEdit?: () => void;
  /** True while the tick is still queued to send. */
  unsynced?: boolean;
}

/**
 * The one interaction that matters: a tired person, one hand, 7am.
 *
 * The whole row is the target, not just the checkbox, and "done" is signalled
 * four ways at once — filled circle, drawn check, strikethrough and the
 * attribution line — so it never depends on colour alone.
 *
 * Read aloud it is one sentence rather than four fragments: the default name
 * for a `checkbox` is its contents, which would run the title, the attribution
 * and the notes together with no punctuation between them.
 */
export function TaskRow({ task, meId, timezone, onToggle, onEdit, unsynced }: TaskRowProps) {
  const done = Boolean(task.completion);

  return (
    <div className="relative">
      <div
        role="checkbox"
        aria-checked={done}
        aria-label={taskRowLabel(task, meId, timezone, unsynced)}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            onToggle();
          }
        }}
        className="card flex min-h-16 cursor-pointer items-center gap-3.5 rounded-2xl px-4 py-2.5 transition-transform duration-100 select-none active:scale-[0.97]"
      >
        <span
          aria-hidden="true"
          className={`flex size-[30px] shrink-0 items-center justify-center rounded-full ${
            done ? 'anim-pop bg-accent text-check-ink' : 'border-2 border-outline'
          }`}
        >
          {done && <CheckIcon className="anim-check" />}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={`truncate text-lg ${
              done ? 'text-muted line-through decoration-[1.5px]' : 'font-medium'
            }`}
          >
            {task.title}
          </span>
          {task.completion && (
            <span className="truncate text-[13px] font-medium text-accent-ink">
              {whoDidIt(task.completion, meId, timezone)}
              {unsynced && ' · not synced yet'}
            </span>
          )}
          {!done && task.notes && (
            <span className="truncate text-[13px] text-muted">{task.notes}</span>
          )}
        </div>
      </div>

      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${task.title}`}
          className="absolute top-1/2 right-1 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-muted opacity-70"
        >
          <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>
      )}
    </div>
  );
}
