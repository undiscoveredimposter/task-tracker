/**
 * The offer to move onto a new build.
 *
 * The service worker registers with `registerType: 'prompt'`, so a new build
 * downloads, installs, and then sits waiting for something to tell it to take
 * over. Nothing did — an installed app could stay on an old version for as long
 * as it was left open, with no way for us to reach it. This is that something,
 * and it asks first: reloading the page under a half-finished tick at 7am is the
 * one moment an update must not happen by itself.
 *
 * Kept clear of `virtual:pwa-register`, which only exists inside a Vite build.
 * lib/serviceWorker.ts joins the two together.
 */

/** What the update bar is currently saying, if anything. */
export type UpdateState = 'idle' | 'offline-ready' | 'update-ready' | 'updating';

/** The part of `RegisterSWOptions` this drives. */
export interface RegisterSWOptions {
  immediate?: boolean;
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
}

/** `registerSW` from `virtual:pwa-register`, narrowed to what is used here. */
export type RegisterSW = (options: RegisterSWOptions) => (reloadPage?: boolean) => Promise<void>;

export interface UpdateStore {
  subscribe(listener: () => void): () => void;
  snapshot(): UpdateState;
  /** Hands over to the waiting build; the page reloads once it has control. */
  apply(): void;
  dismiss(): void;
}

/** How long "ready to work offline" stays up. Said once, then out of the way. */
export const OFFLINE_READY_MS = 5000;

export function createUpdateStore(register: RegisterSW): UpdateStore {
  const listeners = new Set<() => void>();
  let state: UpdateState = 'idle';
  let hideOfflineReady: ReturnType<typeof setTimeout> | undefined;

  const set = (next: UpdateState): void => {
    // useSyncExternalStore re-reads on every notification, so repeating
    // ourselves would re-render the app for nothing.
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  };

  const updateSW = register({
    // On load rather than on first paint: the worker can wait, the screen
    // someone is staring at cannot.
    immediate: false,

    onNeedRefresh: () => {
      // A pending offline-ready timer would otherwise fire later and quietly
      // clear the offer that replaced it.
      clearTimeout(hideOfflineReady);
      set('update-ready');
    },

    onOfflineReady: () => {
      if (state !== 'idle') return;
      set('offline-ready');
      hideOfflineReady = setTimeout(() => set('idle'), OFFLINE_READY_MS);
    },
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    snapshot: () => state,

    apply() {
      if (state !== 'update-ready') return;
      set('updating');
      // The plugin reloads the page itself once the new worker takes control.
      // The gap before that is long enough on a tired phone to be tapped again,
      // which is why the bar changes what it says in the meantime.
      void updateSW();
    },

    dismiss() {
      if (state === 'updating') return;
      clearTimeout(hideOfflineReady);
      // Deliberately not remembered. The build is still waiting, so workbox
      // announces it again on the next launch, and one stray tap cannot strand
      // someone on an old version for good.
      set('idle');
    },
  };
}
