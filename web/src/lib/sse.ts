import type { ServerEvent } from '@tally/shared';

/**
 * Minimal Server-Sent Events parser.
 *
 * The browser's own EventSource can't attach an Authorization header, and the
 * API is token-authenticated — putting the token in the query string would leak
 * it into proxy and access logs. So the stream is read with fetch instead, and
 * this turns the raw byte chunks back into events.
 */
export class SseParser {
  private buffer = '';

  /** Feeds a chunk in and returns whatever complete events it finished. */
  push(chunk: string): ServerEvent[] {
    // Normalise line endings first — some proxies rewrite \n to \r\n, which
    // would otherwise leave a stray \r glued to the end of every JSON payload.
    this.buffer += chunk.replace(/\r\n/g, '\n');

    const events: ServerEvent[] = [];
    let boundary = this.buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);

      const event = this.parseBlock(block);
      if (event) events.push(event);

      boundary = this.buffer.indexOf('\n\n');
    }

    return events;
  }

  private parseBlock(block: string): ServerEvent | null {
    const data = block
      .split('\n')
      // Comments (": ping") and directives (retry:, event:, id:) aren't payload.
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('');

    if (!data) return null;

    try {
      return JSON.parse(data) as ServerEvent;
    } catch {
      // A truncated or malformed event must not take the connection down with
      // it — drop this one and carry on reading.
      return null;
    }
  }
}
