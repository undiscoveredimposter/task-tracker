import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Task } from '@tally/shared';
import {
  REORDER_HINT,
  droppedAnnouncement,
  liftedAnnouncement,
  moveCancelledAnnouncement,
  movingAnnouncement,
  reorderHandleLabel,
} from '../lib/a11y';
import {
  clampTop,
  dropIndex,
  edgeScrollDelta,
  keyboardTarget,
  shiftsFor,
  type RowBox,
} from '../lib/reorder';
import { TaskRow } from './TaskRow';
import { GripIcon } from './ui';

/**
 * The task column, and the two ways of rearranging it.
 *
 * **Touch waits.** A finger on the handle picks nothing up until it has stayed
 * there for `LONG_PRESS_MS`; until then the browser owns the gesture and a flick
 * scrolls the list exactly as it would anywhere else. Nothing here sets
 * `touch-action: none` on the handle, which is the usual way this gets built and
 * the reason so many lists become unscrollable near their handles. Scrolling is
 * only taken away once a row is genuinely in the air, and then by preventing
 * `touchmove` for as long as the drag lasts.
 *
 * **Mouse and pen do not.** Same pointer events, same code below the pickup —
 * only the pickup differs, because a cursor cannot start a scroll by accident
 * and holding a button down for half a second to move a row feels broken.
 *
 * **Neither is required.** Enter lifts the row, the arrow keys move it, Enter
 * drops it and Escape puts it back. Every step of both paths is announced,
 * because the whole interaction is otherwise something that only happened
 * visually.
 */

/** How long a finger has to stay still on the handle before the row comes up. */
const LONG_PRESS_MS = 400;

/** How far it may drift in that time and still count as staying still. */
const SLOP = 8;

/** A finger on the handle that has not yet earned the right to drag. */
interface Pending {
  taskId: string;
  pointerId: number;
  x: number;
  y: number;
  timer: number;
}

/** Everything a move in progress needs, kept out of state so a pointer that
    moves 60 times a second doesn't have to re-register anything. */
interface Session {
  taskId: string;
  title: string;
  from: number;
  to: number;
  rows: RowBox[];
  /** Null when the keyboard is driving: there is no pointer to follow. */
  pointerId: number | null;
  /** How far down the row the finger landed, so it stays under the same spot. */
  grab: number;
  lastClientY: number;
}

/** The same move, as much of it as the screen needs. */
interface Lift {
  taskId: string;
  from: number;
  to: number;
  rows: RowBox[];
  pointerId: number | null;
  /** Where the dragged row's top has reached. Null on the keyboard path. */
  top: number | null;
}

interface TaskListProps {
  tasks: Task[];
  meId: string | null;
  timezone: string;
  onToggle: (task: Task) => void;
  onEdit?: (task: Task) => void;
  /** Absent for viewers, who get no handle and no way into any of this. */
  onMove?: (taskId: string, toIndex: number) => void;
}

export function TaskList({ tasks, meId, timezone, onToggle, onEdit, onMove }: TaskListProps) {
  const columnRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const pending = useRef<Pending | null>(null);
  const session = useRef<Session | null>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  const [said, setSaid] = useState('');
  const hintId = useId();

  const count = tasks.length;
  // One task has no other slot to be in, so the handle would be a control that
  // cannot do anything.
  const canReorder = Boolean(onMove) && count > 1;

  /* ── Measuring ─────────────────────────────────────────────────────────── */

  /** The column's own coordinates. Client space slides when the column scrolls. */
  const contentBase = (): number => {
    const column = columnRef.current;
    return column ? column.getBoundingClientRect().top - column.scrollTop : 0;
  };

  /** Every row as it is right now, which is the last honest look we get: from
      the next frame on, the rows on screen are ones this drag has moved. */
  const measure = (): RowBox[] => {
    const base = contentBase();
    return tasks.map((task) => {
      const box = rowRefs.current.get(task.id)?.getBoundingClientRect();
      return box ? { top: box.top - base, height: box.height } : { top: 0, height: 0 };
    });
  };

  /* ── The move itself ───────────────────────────────────────────────────── */

  const forgetPending = (): void => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };

  /** The half of a session the screen needs, at the position it has reached. */
  const asLift = (active: Session, top: number | null): Lift => ({
    taskId: active.taskId,
    from: active.from,
    to: active.to,
    rows: active.rows,
    pointerId: active.pointerId,
    top,
  });

  const end = (): void => {
    forgetPending();
    session.current = null;
    setLift(null);
  };

  const pickUp = (taskId: string, pointerId: number | null, clientY: number): void => {
    if (!canReorder || session.current) return;

    // Re-found rather than passed in: on touch this runs the best part of a
    // second after the finger landed, and the list can have changed since.
    const from = tasks.findIndex((task) => task.id === taskId);
    const task = tasks[from];
    const rows = measure();
    const row = rows[from];
    if (!task || !row) return;

    const active: Session = {
      taskId,
      title: task.title,
      from,
      to: from,
      rows,
      pointerId,
      grab: pointerId === null ? 0 : clientY - contentBase() - row.top,
      lastClientY: clientY,
    };
    session.current = active;
    setLift(asLift(active, pointerId === null ? null : row.top));
    setSaid(liftedAnnouncement(task.title, from + 1, count));
  };

  const follow = (clientY: number): void => {
    const active = session.current;
    if (!active || active.pointerId === null) return;

    active.lastClientY = clientY;
    const top = clampTop(active.rows, active.from, clientY - contentBase() - active.grab);
    const to = dropIndex(active.rows, active.from, top);
    if (to !== active.to) {
      active.to = to;
      setSaid(movingAnnouncement(active.title, to + 1, count));
    }
    setLift(asLift(active, top));
  };

  const step = (key: string): boolean => {
    const active = session.current;
    if (!active) return false;

    const to = keyboardTarget(active.to, key, count);
    if (to === null) return false;

    active.to = to;
    setSaid(movingAnnouncement(active.title, to + 1, count));
    setLift(asLift(active, null));
    return true;
  };

  const drop = (): void => {
    const active = session.current;
    if (!active) return;

    const { taskId, title, from, to } = active;
    end();
    setSaid(droppedAnnouncement(title, to + 1, count));
    if (to !== from) onMove?.(taskId, to);
  };

  const cancel = (): void => {
    const active = session.current;
    if (!active) return;

    end();
    setSaid(moveCancelledAnnouncement(active.title, active.from + 1, count));
  };

  /** Drags the column along when the finger is held near either end of it. */
  const autoScroll = (): void => {
    const column = columnRef.current;
    const active = session.current;
    if (!column || !active || active.pointerId === null) return;

    const box = column.getBoundingClientRect();
    const delta = edgeScrollDelta(active.lastClientY, box.top, box.bottom);
    if (delta === 0) return;

    const before = column.scrollTop;
    column.scrollTop += delta;
    // Nothing moved, so the column is already at one end; re-running the maths
    // would only set the same state again every frame.
    if (column.scrollTop !== before) follow(active.lastClientY);
  };

  /* ── Wiring ────────────────────────────────────────────────────────────── */

  /* The window listeners below are registered once per drag but must call the
     current render's closures, or a move commits against the list as it was
     when the finger landed. */
  const live = useRef({ follow, drop, cancel, autoScroll });
  useEffect(() => {
    live.current = { follow, drop, cancel, autoScroll };
  });

  const activePointer = lift?.pointerId ?? null;
  useEffect(() => {
    if (activePointer === null) return;

    const onMove = (event: PointerEvent) => {
      if (event.pointerId === activePointer) live.current.follow(event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId === activePointer) live.current.drop();
    };
    const onCancel = (event: PointerEvent) => {
      if (event.pointerId === activePointer) live.current.cancel();
    };
    // The long press is what bought the right to take scrolling away, and only
    // for as long as a row is actually in the air. Without this the browser
    // starts scrolling on the first touchmove and cancels the pointer with it.
    const hold = (event: TouchEvent) => event.preventDefault();

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('touchmove', hold, { passive: false });

    let frame = requestAnimationFrame(function loop() {
      live.current.autoScroll();
      frame = requestAnimationFrame(loop);
    });

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('touchmove', hold);
      cancelAnimationFrame(frame);
    };
  }, [activePointer]);

  /* A refetch, or somebody else's change arriving over the stream, while a row
     is in the air. Every measurement in the session describes a list that no
     longer exists, so there is no honest way to finish the gesture. The order
     rather than the tasks themselves: a tick landing mid-drag rebuilds the
     array without moving anything, and is no reason to drop what is in hand. */
  const order = tasks.map((task) => task.id).join(' ');
  useEffect(() => {
    if (session.current) cancel();
  }, [order]);

  useEffect(() => () => forgetPending(), []);

  /* ── Handle events ─────────────────────────────────────────────────────── */

  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>, task: Task): void => {
    // Secondary mouse buttons open menus; they do not pick things up.
    if (!canReorder || session.current || event.button > 0) return;

    if (event.pointerType !== 'touch') {
      pickUp(task.id, event.pointerId, event.clientY);
      return;
    }

    forgetPending();
    const { pointerId, clientX, clientY } = event;
    pending.current = {
      taskId: task.id,
      pointerId,
      x: clientX,
      y: clientY,
      timer: window.setTimeout(() => {
        pending.current = null;
        pickUp(task.id, pointerId, clientY);
      }, LONG_PRESS_MS),
    };
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const waiting = pending.current;
    if (!waiting || waiting.pointerId !== event.pointerId) return;

    // The finger is going somewhere: it is scrolling, not picking up. The
    // browser's own pointercancel says the same thing a moment later, but only
    // once it has decided, and by then the long press may already have fired.
    const moved =
      Math.abs(event.clientY - waiting.y) > SLOP || Math.abs(event.clientX - waiting.x) > SLOP;
    if (moved) forgetPending();
  };

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, task: Task): void => {
    if (!canReorder) return;
    const active = session.current;
    const lifting = active?.taskId === task.id && active.pointerId === null;

    if (!lifting) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pickUp(task.id, null, 0);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      drop();
      return;
    }
    // Otherwise the arrow keys scroll the column out from under the row.
    if (step(event.key)) event.preventDefault();
  };

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  const shifts = lift ? shiftsFor(lift.rows, lift.from, lift.to) : null;

  /** How far this row is from where it was laid out. */
  const offsetOf = (index: number): number => {
    // The dragged row follows the finger; the rest slide to make room for it.
    // A keyboard move has no finger, so that row travels with the others.
    if (lift && lift.top !== null && index === lift.from) {
      return lift.top - (lift.rows[lift.from]?.top ?? 0);
    }
    return shifts?.[index] ?? 0;
  };

  return (
    <>
      <div
        ref={columnRef}
        className={`flex flex-1 flex-col gap-2 overflow-y-auto px-4 pt-0.5 pb-32 md:pb-6 ${
          lift ? 'select-none' : ''
        }`}
      >
        {tasks.map((task, index) => {
          const lifted = lift?.taskId === task.id;

          return (
            <div
              key={task.id}
              ref={(node) => {
                if (node) rowRefs.current.set(task.id, node);
                else rowRefs.current.delete(task.id);
              }}
              style={
                lift
                  ? { transform: `translateY(${offsetOf(index)}px)${lifted ? ' scale(1.02)' : ''}` }
                  : undefined
              }
              className={`${
                lifted ? 'relative z-10 rounded-2xl shadow-[0_10px_28px_rgba(0,0,0,.35)]' : ''
              } ${lift && !lifted ? 'transition-transform duration-150' : ''}`}
            >
              <TaskRow
                task={task}
                meId={meId}
                timezone={timezone}
                onToggle={() => onToggle(task)}
                onEdit={onEdit ? () => onEdit(task) : undefined}
                handle={
                  canReorder ? (
                    <button
                      type="button"
                      aria-label={reorderHandleLabel(task.title, index + 1, count)}
                      aria-describedby={hintId}
                      aria-pressed={lifted}
                      onPointerDown={(event) => onHandleDown(event, task)}
                      onPointerMove={onHandleMove}
                      onPointerUp={forgetPending}
                      onPointerCancel={forgetPending}
                      // A long press here is this control's own gesture. The
                      // browser's — the callout, or a context menu — arrives at
                      // roughly the same moment and cancels the pointer with it.
                      onContextMenu={(event) => event.preventDefault()}
                      onKeyDown={(event) => onHandleKeyDown(event, task)}
                      // Focus leaving a lifted row keeps the move rather than
                      // throwing it away: it is where the person put it.
                      onBlur={() => {
                        const active = session.current;
                        if (active?.taskId === task.id && active.pointerId === null) drop();
                      }}
                      className={`flex size-11 items-center justify-center rounded-full select-none ${
                        lifted ? 'cursor-grabbing text-accent-ink' : 'cursor-grab text-muted'
                      }`}
                    >
                      <GripIcon />
                    </button>
                  ) : undefined
                }
              />
            </div>
          );
        })}
      </div>

      {/* Mounted always and empty until there is something to say, for the same
          reason as the offline banner's: a region that arrives with its text
          already in it may never be announced at all. */}
      <p role="status" className="sr-only">
        {said}
      </p>
      <p id={hintId} className="sr-only">
        {REORDER_HINT}
      </p>
    </>
  );
}
