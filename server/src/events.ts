import type { Response } from 'express';
import type { ServerEvent } from '@tally/shared';
import { query } from './db.js';

/**
 * Live updates over Server-Sent Events.
 *
 * SSE rather than WebSockets because the traffic is one-directional — writes go
 * over ordinary HTTP — and SSE reconnects on its own and survives proxies.
 *
 * Subscribers are held in memory, which assumes a single app instance. Running
 * two containers would mean a tick on instance A never reaching a listener on
 * instance B; the fix is Postgres LISTEN/NOTIFY in place of this map, with no
 * change to the API. Documented in docs/PLAN.md §6.
 */

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
 * Pushes an event to everyone who can see the list. `exceptUserId` skips the
 * person who caused it — their own UI already updated optimistically.
 */
export async function broadcast(
  listId: string,
  event: ServerEvent,
  exceptUserId?: string,
): Promise<void> {
  if (subscribers.size === 0) return;

  const members = await query<{ user_id: string }>(
    'SELECT user_id FROM list_members WHERE list_id = $1',
    [listId],
  );
  const audience = new Set(members.map((m) => m.user_id));

  for (const subscriber of subscribers) {
    if (!audience.has(subscriber.userId)) continue;
    if (exceptUserId && subscriber.userId === exceptUserId) continue;
    write(subscriber.res, event);
  }
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
