import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OFFLINE_READY_MS,
  createUpdateStore,
  type RegisterSW,
  type RegisterSWOptions,
} from './appUpdate';

/** Stands in for `virtual:pwa-register`, so the callbacks can be fired by hand. */
class FakeWorker {
  options: RegisterSWOptions | undefined;
  /** How many times the waiting build was told to take over. */
  handovers = 0;

  register: RegisterSW = (options) => {
    this.options = options;
    return async () => void this.handovers++;
  };

  /** A new build has finished downloading and is waiting. */
  needsRefresh(): void {
    this.options?.onNeedRefresh?.();
  }

  /** The first install has finished precaching the shell. */
  offlineReady(): void {
    this.options?.onOfflineReady?.();
  }
}

let worker: FakeWorker;

beforeEach(() => {
  vi.useFakeTimers();
  worker = new FakeWorker();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createUpdateStore', () => {
  it('says nothing until the worker does', () => {
    const store = createUpdateStore(worker.register);
    expect(store.snapshot()).toBe('idle');
  });

  it('leaves the worker off the critical path of the first paint', () => {
    createUpdateStore(worker.register);
    expect(worker.options?.immediate).toBe(false);
  });

  it('offers the new version once one is waiting', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();
    expect(store.snapshot()).toBe('update-ready');
  });

  it('never applies an update on its own', () => {
    createUpdateStore(worker.register);
    worker.needsRefresh();
    vi.advanceTimersByTime(60_000);
    expect(worker.handovers).toBe(0);
  });
});

describe('subscribers', () => {
  it('hear about a change', () => {
    const store = createUpdateStore(worker.register);
    const listener = vi.fn();
    store.subscribe(listener);

    worker.needsRefresh();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('are left alone when nothing actually changed', () => {
    // useSyncExternalStore re-reads on every notification; repeating ourselves
    // would re-render the whole app for nothing.
    const store = createUpdateStore(worker.register);
    const listener = vi.fn();
    store.subscribe(listener);

    worker.needsRefresh();
    worker.needsRefresh();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stop hearing anything once released', () => {
    const store = createUpdateStore(worker.register);
    const listener = vi.fn();
    store.subscribe(listener)();

    worker.needsRefresh();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('apply', () => {
  it('hands over to the waiting build', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();

    store.apply();

    expect(worker.handovers).toBe(1);
  });

  it('says it is going, because the reload is not instant', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();

    store.apply();

    expect(store.snapshot()).toBe('updating');
  });

  it('ignores a second tap while the first is still landing', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();

    store.apply();
    store.apply();

    expect(worker.handovers).toBe(1);
  });

  it('does nothing when there is nothing waiting', () => {
    const store = createUpdateStore(worker.register);

    store.apply();

    expect(worker.handovers).toBe(0);
    expect(store.snapshot()).toBe('idle');
  });
});

describe('dismiss', () => {
  it('puts the offer away', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();

    store.dismiss();

    expect(store.snapshot()).toBe('idle');
  });

  it('offers again on the next launch', () => {
    // Nothing about the dismissal is remembered, and workbox re-announces a
    // worker that is already waiting when the app starts. One stray tap must
    // not strand someone on an old build for good.
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();
    store.dismiss();

    const relaunched = createUpdateStore(worker.register);
    worker.needsRefresh();

    expect(relaunched.snapshot()).toBe('update-ready');
  });

  it('will not cancel a reload already on its way', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();
    store.apply();

    store.dismiss();

    expect(store.snapshot()).toBe('updating');
  });
});

describe('offline ready', () => {
  it('states the offline promise rather than leaving it assumed', () => {
    const store = createUpdateStore(worker.register);
    worker.offlineReady();
    expect(store.snapshot()).toBe('offline-ready');
  });

  it('says it once and then gets out of the way', () => {
    const store = createUpdateStore(worker.register);
    worker.offlineReady();

    vi.advanceTimersByTime(OFFLINE_READY_MS);

    expect(store.snapshot()).toBe('idle');
  });

  it('gives way to an update, which is the one worth acting on', () => {
    const store = createUpdateStore(worker.register);
    worker.needsRefresh();

    worker.offlineReady();

    expect(store.snapshot()).toBe('update-ready');
  });

  it('does not take the update offer down with it when it expires', () => {
    const store = createUpdateStore(worker.register);
    worker.offlineReady();

    worker.needsRefresh();
    vi.advanceTimersByTime(OFFLINE_READY_MS);

    expect(store.snapshot()).toBe('update-ready');
  });
});
