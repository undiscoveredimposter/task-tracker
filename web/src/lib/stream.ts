import type { ServerEvent } from '@tally/shared';
import { SseParser } from './sse';

interface StreamOptions {
  getToken: () => Promise<string | null>;
  onEvent: (event: ServerEvent) => void;
  onConnected?: (connected: boolean) => void;
}

/** Backoff for reconnects, capped so a long outage doesn't leave the app asleep. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * Holds a live connection to /api/stream, reconnecting for as long as the
 * caller wants it. Returns a function that closes it.
 */
export function connectStream(options: StreamOptions): () => void {
  const controller = new AbortController();
  let attempt = 0;
  let stopped = false;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const token = await options.getToken();
        if (!token) throw new Error('not signed in');

        const response = await fetch('/api/stream', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);

        attempt = 0;
        options.onConnected?.(true);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            options.onEvent(event);
          }
        }
      } catch {
        // Any failure — offline, token expired, server restart — is handled the
        // same way: report the drop and try again shortly.
      }

      if (stopped) return;
      options.onConnected?.(false);

      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30000;
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  };

  void run();

  return () => {
    stopped = true;
    controller.abort();
  };
}
