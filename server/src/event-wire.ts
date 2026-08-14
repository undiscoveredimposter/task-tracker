import { z } from 'zod';
import type { ServerEvent } from '@tally/shared';

/**
 * The format an event travels in when it crosses between app instances.
 *
 * Kept apart from `events.ts` so it can be tested without a database or a
 * socket: everything here is a pure function of its input.
 */

/** Postgres rejects a NOTIFY whose payload exceeds this, and it is not tunable. */
export const NOTIFY_PAYLOAD_LIMIT = 8000;

/**
 * What we allow ourselves before degrading the event. The gap below the hard
 * limit is deliberate: a payload near the edge should turn into a "go and
 * refetch" on our terms, in code we can read, rather than becoming an error
 * from the database at the moment somebody ticks something.
 */
export const NOTIFY_PAYLOAD_BUDGET = 7000;

export interface EventEnvelope {
  /** Bumped if the shape changes, so a mid-deploy instance drops what it can't read. */
  v: 1;
  /** The instance that published it — how the publisher ignores its own echo. */
  origin: string;
  /** Whose members should receive it. Resolved by each instance, not sent. */
  listId: string;
  event: ServerEvent;
  /** The person who caused it; their own UI already updated optimistically. */
  except: string | null;
}

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`Event payload is ${bytes} bytes, over the ${NOTIFY_PAYLOAD_LIMIT}-byte NOTIFY limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/* ── Validation ──────────────────────────────────────────────────────────── */

const userRefSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  photoUrl: z.string().nullable(),
});

const completionSchema = z.object({ by: userRefSchema, at: z.string() });

const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.completed'),
    listId: z.string(),
    taskId: z.string(),
    periodKey: z.string(),
    completion: completionSchema,
  }),
  z.object({
    type: z.literal('task.uncompleted'),
    listId: z.string(),
    taskId: z.string(),
    periodKey: z.string(),
  }),
  z.object({ type: z.literal('task.changed'), listId: z.string() }),
  z.object({ type: z.literal('list.changed'), listId: z.string() }),
  z.object({ type: z.literal('list.deleted'), listId: z.string() }),
  z.object({ type: z.literal('members.changed'), listId: z.string() }),
  z.object({ type: z.literal('hello'), userId: z.string() }),
]);

// Compile-time proof that the schema and the shared type have not drifted
// apart. If somebody adds an event to `@tally/shared` and forgets this file,
// the typecheck fails here rather than the event silently vanishing between
// instances at runtime.
type ParsedEvent = z.infer<typeof serverEventSchema>;
export type _SchemaCoversType = ServerEvent extends ParsedEvent ? true : never;
export type _TypeCoversSchema = ParsedEvent extends ServerEvent ? true : never;
const _schemaCoversType: _SchemaCoversType = true;
const _typeCoversSchema: _TypeCoversSchema = true;
void _schemaCoversType;
void _typeCoversSchema;

const envelopeSchema = z.object({
  v: z.literal(1),
  origin: z.string(),
  listId: z.string(),
  event: serverEventSchema,
  except: z.string().nullable(),
});

/* ── Encoding ────────────────────────────────────────────────────────────── */

/**
 * The identifier-only form of an event. `task.changed` carries nothing but the
 * list, and the web client already responds to it by refetching, so it is a
 * safe thing to fall back to for any event whose body got too big to send.
 */
export function compactEvent(event: ServerEvent): ServerEvent {
  switch (event.type) {
    case 'task.completed':
    case 'task.uncompleted':
      return { type: 'task.changed', listId: event.listId };
    default:
      return event;
  }
}

export function encodeEnvelope(envelope: EventEnvelope): string {
  const full = JSON.stringify(envelope);
  if (Buffer.byteLength(full) <= NOTIFY_PAYLOAD_BUDGET) return full;

  const compact = JSON.stringify({ ...envelope, event: compactEvent(envelope.event) });
  const bytes = Buffer.byteLength(compact);
  if (bytes > NOTIFY_PAYLOAD_LIMIT) throw new PayloadTooLargeError(bytes);
  return compact;
}

/** Returns null for anything malformed — the caller logs and drops it. */
export function decodeEnvelope(raw: string): EventEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = envelopeSchema.safeParse(parsed);
  return result.success ? (result.data as EventEnvelope) : null;
}

/* ── Channel names ───────────────────────────────────────────────────────── */

/**
 * `LISTEN` takes an identifier, which cannot be a bound parameter, so the
 * channel name is the one string in this module that gets concatenated into
 * SQL. Anything that is not already a bare lower-case identifier is refused at
 * config load rather than quoted and hoped for.
 */
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME.test(name);
}
