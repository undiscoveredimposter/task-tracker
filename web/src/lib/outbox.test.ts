import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Outbox, type PendingTick } from './outbox';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  raw(key: string): string | null {
    return this.getItem(key);
  }
  poison(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const tick = (taskId: string, action: PendingTick['action'] = 'complete', at = 1): PendingTick => ({
  taskId,
  listId: 'home',
  action,
  at,
});

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe('Outbox', () => {
  it('starts empty', () => {
    expect(new Outbox(storage).size).toBe(0);
  });

  it('keeps queued ticks in the order they were made', () => {
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed'));
    outbox.enqueue(tick('bins'));
    expect(outbox.pending.map((p) => p.taskId)).toEqual(['feed', 'bins']);
  });

  it('collapses repeated changes to one task down to the last one', () => {
    // Tick then untick while offline must not replay as two operations —
    // the server would end up in whichever state the race decided.
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed', 'complete', 1));
    outbox.enqueue(tick('feed', 'uncomplete', 2));
    expect(outbox.size).toBe(1);
    expect(outbox.pending[0]).toMatchObject({ taskId: 'feed', action: 'uncomplete' });
  });

  it('moves a re-touched task to the back of the queue', () => {
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed'));
    outbox.enqueue(tick('bins'));
    outbox.enqueue(tick('feed', 'uncomplete', 3));
    expect(outbox.pending.map((p) => p.taskId)).toEqual(['bins', 'feed']);
  });

  it('survives a page reload', () => {
    const first = new Outbox(storage);
    first.enqueue(tick('feed'));
    expect(new Outbox(storage).pending.map((p) => p.taskId)).toEqual(['feed']);
  });

  it('shrugs off corrupt storage instead of failing to start', () => {
    storage.poison('tally.outbox', '{not json');
    expect(new Outbox(storage).size).toBe(0);
  });

  it('ignores stored data of the wrong shape', () => {
    storage.poison('tally.outbox', '{"nope": true}');
    expect(new Outbox(storage).size).toBe(0);
  });

  describe('flush', () => {
    it('sends everything and empties the queue', async () => {
      const outbox = new Outbox(storage);
      outbox.enqueue(tick('feed'));
      outbox.enqueue(tick('bins'));

      const send = vi.fn().mockResolvedValue(undefined);
      const result = await outbox.flush(send);

      expect(send).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ sent: 2, remaining: 0 });
      expect(outbox.size).toBe(0);
    });

    it('sends in queue order', async () => {
      const outbox = new Outbox(storage);
      outbox.enqueue(tick('feed'));
      outbox.enqueue(tick('bins'));

      const seen: string[] = [];
      await outbox.flush(async (pending) => {
        seen.push(pending.taskId);
      });
      expect(seen).toEqual(['feed', 'bins']);
    });

    it('stops at the first network failure and keeps what it could not send', async () => {
      // Still offline halfway through: the rest must survive for the next attempt.
      const outbox = new Outbox(storage);
      outbox.enqueue(tick('feed'));
      outbox.enqueue(tick('bins'));
      outbox.enqueue(tick('post'));

      const send = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('offline'));

      const result = await outbox.flush(send);

      expect(result).toEqual({ sent: 1, remaining: 2 });
      expect(outbox.pending.map((p) => p.taskId)).toEqual(['bins', 'post']);
    });

    it('persists what remains after a partial flush', async () => {
      const outbox = new Outbox(storage);
      outbox.enqueue(tick('feed'));
      outbox.enqueue(tick('bins'));

      await outbox.flush(vi.fn().mockRejectedValue(new Error('offline')));

      expect(new Outbox(storage).pending.map((p) => p.taskId)).toEqual(['feed', 'bins']);
    });

    it('does nothing when there is nothing queued', async () => {
      const send = vi.fn();
      const result = await new Outbox(storage).flush(send);
      expect(send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, remaining: 0 });
    });

    it('drops a tick the server rejects outright, rather than retrying forever', async () => {
      // A 403 or a deleted task will never succeed; keeping it would wedge the
      // queue and block every later tick behind it.
      const outbox = new Outbox(storage);
      outbox.enqueue(tick('gone'));
      outbox.enqueue(tick('feed'));

      const send = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }))
        .mockResolvedValueOnce(undefined);

      const result = await outbox.flush(send);

      expect(result).toEqual({ sent: 1, remaining: 0, dropped: 1 });
      expect(outbox.size).toBe(0);
    });
  });

  it('reports whether a given task has an unsent change', () => {
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed'));
    expect(outbox.has('feed')).toBe(true);
    expect(outbox.has('bins')).toBe(false);
  });

  it('can be emptied outright, for sign-out', () => {
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed'));
    outbox.clear();
    expect(outbox.size).toBe(0);
    expect(new Outbox(storage).size).toBe(0);
  });

  it('leaves no key behind when cleared, so sign-out really does clear it', () => {
    const outbox = new Outbox(storage);
    outbox.enqueue(tick('feed'));
    outbox.clear();
    expect(storage.has('tally.outbox')).toBe(false);
  });
});
