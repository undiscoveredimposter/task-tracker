export type PendingAction = 'complete' | 'uncomplete';

export interface PendingTick {
  taskId: string;
  listId: string;
  action: PendingAction;
  /** When the person actually tapped, not when it was sent. */
  at: number;
}

export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FlushResult {
  sent: number;
  /** Still queued after this attempt — what the offline banner counts. */
  remaining: number;
  /** Abandoned because the server will never accept them. */
  dropped?: number;
}

const STORAGE_KEY = 'tally.outbox';

/** 4xx other than these means the request is wrong, not that the network is. */
function isPermanentFailure(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isPendingTick(value: unknown): value is PendingTick {
  if (!value || typeof value !== 'object') return false;
  const tick = value as Partial<PendingTick>;
  return (
    typeof tick.taskId === 'string' &&
    typeof tick.listId === 'string' &&
    (tick.action === 'complete' || tick.action === 'uncomplete') &&
    typeof tick.at === 'number'
  );
}

/**
 * Ticks made while offline, waiting to reach the server.
 *
 * Replay is safe because completing is idempotent server-side — the unique
 * constraint on (task_id, period_key) means sending the same tick twice cannot
 * produce a duplicate. That is what lets this be a plain queue rather than a
 * synchronisation protocol.
 */
export class Outbox {
  private queue: PendingTick[] = [];

  constructor(
    private readonly storage: OutboxStorage,
    private readonly key: string = STORAGE_KEY,
  ) {
    this.queue = this.read();
  }

  private read(): PendingTick[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      // Anything unexpected — a corrupt write, an older format — is discarded
      // rather than allowed to crash the app on launch.
      return Array.isArray(parsed) ? parsed.filter(isPendingTick) : [];
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.queue));
    } catch {
      // Private browsing, or storage full. Losing the queue is better than
      // losing the session, and the tick is already on screen.
    }
  }

  get pending(): PendingTick[] {
    return [...this.queue];
  }

  get size(): number {
    return this.queue.length;
  }

  has(taskId: string): boolean {
    return this.queue.some((tick) => tick.taskId === taskId);
  }

  /**
   * Queues a change, replacing any earlier unsent change to the same task.
   * Ticking then unticking while offline should reach the server as one final
   * state, not as two operations racing each other.
   */
  enqueue(tick: PendingTick): void {
    this.queue = this.queue.filter((existing) => existing.taskId !== tick.taskId);
    this.queue.push(tick);
    this.write();
  }

  clear(): void {
    this.queue = [];
    this.write();
  }

  /**
   * Attempts the queue in order, stopping at the first network failure so the
   * remaining ticks keep their order for the next attempt.
   */
  async flush(send: (tick: PendingTick) => Promise<void>): Promise<FlushResult> {
    let sent = 0;
    let dropped = 0;

    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      try {
        await send(next);
        sent++;
      } catch (error) {
        if (!isPermanentFailure(error)) {
          this.write();
          return { sent, remaining: this.queue.length };
        }
        // Never going to succeed — drop it rather than wedge everything behind it.
        dropped++;
      }
      this.queue.shift();
    }

    this.write();
    return dropped > 0 ? { sent, remaining: 0, dropped } : { sent, remaining: 0 };
  }
}
