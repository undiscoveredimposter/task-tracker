import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import pg from 'pg';
import type { ServerEvent } from '@tally/shared';
import { config } from './config.js';
import { query } from './db.js';
import { decodeEnvelope, encodeEnvelope, type EventEnvelope } from './event-wire.js';
import { PgListener, type ListenerState } from './pg-listener.js';

/**
 * Live updates over Server-Sent Events.
 *
 * SSE rather than WebSockets because the traffic is one-directional — writes go
 * over ordinary HTTP — and SSE reconnects on its own and survives proxies.
 *
 * An SSE connection is held by one process, so the set of subscribers below is
 * necessarily local. What used to make that a single-instance design was that a
 * tick handled by instance A was only ever written to A's own subscribers. Now
 * every mutation is also published on a Postgres channel, and every instance
 * holds a `LISTEN` on it (see pg-listener.ts), so each one delivers to whichever
 * devices happen to be connected to it. Two containers behind the proxy now stay
 * in step. docs/PLAN.md §6.
 *
 * Two details worth keeping straight:
 *
 *  - The publisher writes to its own subscribers directly and then ignores the
 *    echo of its own NOTIFY, matched on `origin`. Going out to the database and
 *    back would be tidier, but it would mean a listener outage silently killing
 *    live updates for people on the *same* instance — a strictly worse failure
 *    than the one this change fixes.
 *  - The payload carries identifiers, never the audience. Each instance resolves
 *    the membership itself, so a large household cannot push a NOTIFY past the
 *    8000-byte ceiling.
 */

/** This process, for the life of it. Only ever compared, never persisted. */
const INSTANCE_ID = randomUUID();

export function instanceId(): string {
  return INSTANCE_ID;
}

interface Subscriber {
  userId: string;
  res: Response;
}

const subscribers = new Set<Subscriber>();

export function subscriberCount(): number {
  return subscribers.size;
}

export function addSubscriber(userId: string, res: Response): () => void {
  const subscriber: Subscriber = { userId, res };
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function write(res: Response, event: ServerEvent): void {
  try {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  } catch {
    // Client vanished mid-write; the close handler will clean it up.
  }
}

export function sendTo(userId: string, event: ServerEvent): void {
  for (const subscriber of subscribers) {
    if (subscriber.userId === userId) write(subscriber.res, event);
  }
}

/**
 * Who should receive an event, resolved from the database on each instance
 * rather than sent in the payload — a large household must not be able to push
 * a NOTIFY past its 8000-byte ceiling.
 *
 * A list's audience is the membership of the space that holds it, which is what
 * makes an event reach someone the list itself was never shared with. The
 * exception is a private list: the `l.owner_id = m.user_id` condition collapses
 * its audience to one person, so a tick on it is never announced to the space.
 */
async function audienceOf(target: EventTarget): Promise<Set<string>> {
  const rows =
    target.kind === 'space'
      ? await query<{ user_id: string }>('SELECT user_id FROM space_members WHERE space_id = $1', [
          target.id,
        ])
      : await query<{ user_id: string }>(
          `SELECT m.user_id
             FROM lists l
             JOIN space_members m ON m.space_id = l.space_id
            WHERE l.id = $1 AND (NOT l.private OR l.owner_id = m.user_id)`,
          [target.id],
        );
  return new Set(rows.map((row) => row.user_id));
}

/** Writes an event to the subscribers this process happens to be holding. */
async function deliverLocally(
  target: EventTarget,
  event: ServerEvent,
  exceptUserId?: string,
): Promise<void> {
  if (subscribers.size === 0) return;

  const audience = await audienceOf(target);

  for (const subscriber of subscribers) {
    if (!audience.has(subscriber.userId)) continue;
    if (exceptUserId && subscriber.userId === exceptUserId) continue;
    write(subscriber.res, event);
  }
}

/** What an event is addressed to: one list, or a whole space. */
interface EventTarget {
  kind: 'list' | 'space';
  id: string;
}

async function fanOut(
  target: EventTarget,
  event: ServerEvent,
  exceptUserId?: string,
): Promise<void> {
  await deliverLocally(target, event, exceptUserId);
  await publish({
    v: 1,
    origin: INSTANCE_ID,
    ...(target.kind === 'space' ? { spaceId: target.id } : { listId: target.id }),
    event,
    except: exceptUserId ?? null,
  });
}

/**
 * Pushes an event to everyone who can see the list, on every instance.
 * `exceptUserId` skips the person who caused it — their own UI already updated
 * optimistically.
 */
export async function broadcast(
  listId: string,
  event: ServerEvent,
  exceptUserId?: string,
): Promise<void> {
  await fanOut({ kind: 'list', id: listId }, event, exceptUserId);
}

/**
 * Pushes an event to every member of a space — a rename, somebody joining or
 * leaving, a list moving in or out. Addressed to the space rather than to each
 * of its lists because the membership is the thing that changed.
 */
export async function broadcastSpace(
  spaceId: string,
  event: ServerEvent,
  exceptUserId?: string,
): Promise<void> {
  await fanOut({ kind: 'space', id: spaceId }, event, exceptUserId);
}

async function publish(envelope: EventEnvelope): Promise<void> {
  try {
    // `pg_notify` rather than `NOTIFY` so the payload is a bound parameter and
    // never has to be escaped into SQL. Sent on a pooled connection outside any
    // transaction, so it fires immediately rather than at some later commit.
    await query('SELECT pg_notify($1, $2)', [config.eventChannel, encodeEnvelope(envelope)]);
  } catch (error) {
    // Local subscribers already have it and every client refetches when its
    // stream reconnects, so a failed fan-out degrades the experience on other
    // instances rather than failing the write that caused it.
    console.error('[tally] live updates: could not publish event', error);
  }
}

/** A payload from another instance, arriving on the channel. */
function receive(payload: string): void {
  const envelope = decodeEnvelope(payload);
  if (!envelope) {
    // Not the payload itself: it can carry a display name and an email address.
    console.error('[tally] live updates: dropped an event this instance could not read');
    return;
  }

  // Our own echo. The subscribers here were written to before it was published.
  if (envelope.origin === INSTANCE_ID) return;

  const target: EventTarget = envelope.spaceId
    ? { kind: 'space', id: envelope.spaceId }
    : { kind: 'list', id: envelope.listId! };

  void deliverLocally(target, envelope.event, envelope.except ?? undefined).catch(
    (error: unknown) => {
      console.error('[tally] live updates: could not deliver an event from another instance', error);
    },
  );
}

/* ── The listener ────────────────────────────────────────────────────────── */

let listener: PgListener | null = null;

/**
 * Opens the dedicated `LISTEN` connection. Deliberately separate from
 * `createApp`, because it owns a long-lived connection and a retry timer —
 * things a test that only wants to make HTTP requests should not have to
 * inherit.
 */
export async function startEventListener(): Promise<void> {
  if (listener) return;

  listener = new PgListener({
    channel: config.eventChannel,
    // A pool client is borrowed and handed back, and the pool closes it when it
    // has been idle a while — either would drop the LISTEN with nothing looking
    // wrong. This connection belongs to the listener alone.
    connect: () => new pg.Client({ connectionString: config.databaseUrl }),
    onPayload: receive,
  });

  await listener.start();
}

export async function stopEventListener(): Promise<void> {
  const current = listener;
  listener = null;
  await current?.stop();
}

/** For the healthcheck: `listening` is the only value that means fully live. */
export function eventListenerState(): ListenerState {
  return listener?.state ?? 'stopped';
}

/** Comment frames keep proxies from closing an idle stream. */
export function startHeartbeat(intervalMs = 25_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    for (const subscriber of subscribers) {
      try {
        subscriber.res.write(': ping\n\n');
      } catch {
        subscribers.delete(subscriber);
      }
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
