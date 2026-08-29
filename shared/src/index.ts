/**
 * The contract between the API and the web client. Types only — nothing here
 * has a runtime cost beyond the two small constant tables at the bottom.
 */

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'every_n_days' | 'none';
export type Role = 'owner' | 'editor' | 'viewer';

/** Monday = 1 … Sunday = 7, matching ISO-8601 and Luxon's `weekday`. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface UserRef {
  id: string;
  displayName: string;
  email: string | null;
  photoUrl: string | null;
}

export interface Me extends UserRef {}

/**
 * A space is who a set of lists is shared with. Membership lives here and
 * nowhere else: your role in a space is your role on every list inside it, so
 * sharing a space once shares everything in it — now and in the future.
 */
export interface SpaceBase {
  id: string;
  name: string;
  emoji: string;
  ownerId: string;
  createdAt: string;
}

export interface SpaceSummary extends SpaceBase {
  /** The caller's role here, which is their role on every list in the space. */
  role: Role;
  members: Member[];
  /** Lists the caller can see in this space — a private one counts only for its owner. */
  listCount: number;
}

/** The cadence settings that together decide when a list clears itself. */
export interface ListSchedule {
  cadence: Cadence;
  /** Only meaningful when cadence is `every_n_days`. */
  cadenceIntervalDays: number;
  /** Only meaningful when cadence is `weekly`. */
  weekStart: Weekday;
  /** IANA zone, e.g. `Europe/London`. */
  timezone: string;
  /** 0–23 in the list's own timezone. Ticks before this hour count for the previous period. */
  resetHour: number;
}

export interface ListBase extends ListSchedule {
  id: string;
  name: string;
  emoji: string;
  color: string;
  ownerId: string;
  /** The space this list is shared through. Every list is in exactly one. */
  spaceId: string;
  /**
   * Kept out of the space: visible only to `ownerId`, however the space is
   * shared. Somewhere to put your own things without a space of their own.
   */
  private: boolean;
  createdAt: string;
}

export interface ListSummary extends ListBase {
  /**
   * The caller's effective role: their role in the space, raised to `owner` on
   * a list they own themselves.
   */
  role: Role;
  taskCount: number;
  doneCount: number;
  /** Identifier of the period currently on screen — see the server's `periods` module. */
  periodKey: string;
  /** When the current period ends and every task unticks. Null when cadence is `none`. */
  resetsAt: string | null;
  members: UserRef[];
}

export interface Completion {
  by: UserRef;
  /** ISO timestamp of the tick. */
  at: string;
}

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes: string | null;
  position: number;
  /** Null when the task is outstanding for the current period. */
  completion: Completion | null;
}

export interface Member extends UserRef {
  role: Role;
  joinedAt: string;
}

export interface ListDetail extends ListSummary {
  tasks: Task[];
  /** The space's members — or just the owner, when the list is private. */
  members: Member[];
}

export interface Invite {
  id: string;
  role: Exclude<Role, 'owner'>;
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
}

export type InviteStatus = 'ok' | 'expired' | 'revoked' | 'used_up' | 'not_found' | 'already_member';

export interface InvitePreview {
  status: InviteStatus;
  /** Absent when status is `not_found`. */
  space?: { name: string; emoji: string; listCount: number; memberCount: number };
  inviterName?: string;
  role?: Exclude<Role, 'owner'>;
}

export interface StatsPerson extends UserRef {
  count: number;
}

export interface Stats {
  /** Number of past periods covered. */
  window: number;
  /** Consecutive completed periods ending with the most recent finished one. */
  streak: number;
  /** Completions across the window. */
  done: number;
  /** Opportunities across the window — tasks × periods. */
  total: number;
  people: StatsPerson[];
}

/* ── Realtime ────────────────────────────────────────────────────────────── */

export type ServerEvent =
  | { type: 'task.completed'; listId: string; taskId: string; periodKey: string; completion: Completion }
  | { type: 'task.uncompleted'; listId: string; taskId: string; periodKey: string }
  | { type: 'task.changed'; listId: string }
  | { type: 'list.changed'; listId: string }
  | { type: 'list.deleted'; listId: string }
  /**
   * The space itself changed — renamed, someone joined or left, a list moved in
   * or out. Broad on purpose: the client answers all of it by refetching, and
   * membership is not worth a finer-grained event.
   */
  | { type: 'space.changed'; spaceId: string }
  | { type: 'hello'; userId: string };

/* ── Request payloads ────────────────────────────────────────────────────── */

/**
 * Renaming yourself. The name is trimmed and capped server-side; nothing else
 * about a profile is editable, so this is the whole body.
 */
export interface UpdateMeBody {
  /** The short name other people see on your avatar and in a members list. */
  displayName: string;
}

export interface CreateSpaceBody {
  name: string;
  emoji?: string;
}

export type UpdateSpaceBody = Partial<CreateSpaceBody>;

export interface CreateListBody extends Partial<ListSchedule> {
  name: string;
  emoji?: string;
  color?: string;
  /** Which space to put it in. Defaults to your own — created on demand. */
  spaceId?: string;
  private?: boolean;
}

/** `spaceId` here moves the list to another space; `private` hides it in place. */
export type UpdateListBody = Partial<CreateListBody>;

export interface CreateTaskBody {
  title: string;
  notes?: string | null;
}

export interface UpdateTaskBody {
  title?: string;
  notes?: string | null;
  position?: number;
}

/**
 * Where to drop a task, said in terms of its new neighbours rather than a
 * number. The server owns `position`; the client only has to name what the task
 * should end up next to. Give one anchor or both — both must be adjacent.
 */
export interface MoveTaskBody {
  /** Put the task directly above this one. */
  before?: string | null;
  /** Put the task directly below this one. */
  after?: string | null;
}

export interface CreateInviteBody {
  role: Exclude<Role, 'owner'>;
  /** Days until the link stops working. Null keeps it alive indefinitely. */
  expiresInDays?: number | null;
  maxUses?: number | null;
}

/* ── Presentation constants shared by both sides ─────────────────────────── */

/** Palette from the Tally design system — `color` on a list is one of these. */
export const LIST_COLORS = [
  { id: 'blurple', hex: '#9184d9', label: 'Blurple' },
  { id: 'slate', hex: '#75798c', label: 'Slate' },
  { id: 'dusk', hex: '#5c5783', label: 'Dusk' },
  { id: 'lilac', hex: '#b5abfc', label: 'Lilac' },
  { id: 'indigo', hex: '#353b80', label: 'Indigo' },
] as const;

export const LIST_EMOJI = ['🏠', '🐈', '🧺', '🪴', '☀️', '📋', '🛒', '🐕', '💊', '🚲', '🧹', '📚'] as const;

export const DEFAULT_SCHEDULE: ListSchedule = {
  cadence: 'daily',
  cadenceIntervalDays: 3,
  weekStart: 1,
  timezone: 'Europe/London',
  resetHour: 4,
};

export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** True when `role` is at least as privileged as `needed`. */
export function roleAtLeast(role: Role, needed: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[needed];
}
