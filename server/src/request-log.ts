import type { RequestHandler, Response } from 'express';

/**
 * One structured line per request: method, path, status, duration, and who did
 * it when we know.
 *
 * Two rules shape the rest of this file.
 *
 * **Nothing that is a credential goes in.** Headers are never read here — not
 * Authorization, not Cookie — and the parts of a *path* that are secrets are
 * replaced before formatting. `/api/invites/token/<token>` and the `/j/<token>`
 * landing page both carry a working key to somebody's list, and the second one
 * is a static request, so it would otherwise sail into an access log without
 * anyone thinking about it. `scrubSecrets` is the belt to that pair of braces.
 *
 * **The SSE stream is logged when it opens, not when it ends.** A stream lives
 * for hours; logging it on completion would produce one line per connection,
 * arriving long after it was any use, with a duration measured in hours.
 */

export type LogFormat = 'json' | 'text';

export interface RequestLogEntry {
  /** `request` for an ordinary response, `stream.open` when an SSE stream starts. */
  event: 'request' | 'stream.open';
  /** ISO 8601. */
  time: string;
  method: string;
  /** Already redacted — see `redactUrl`. */
  path: string;
  status: number;
  /** Absent for `stream.open`, which has not finished and will not for hours. */
  durationMs?: number;
  /** Absent when the caller was not signed in. */
  userId?: string;
}

/**
 * Path prefixes whose next segment is a secret. The value is what to log in its
 * place, which keeps routes distinguishable in the log without the token.
 */
const SECRET_PATH_SEGMENTS: readonly [RegExp, string][] = [
  [/^\/api\/invites\/token\/[^/?]+/i, '/api/invites/token/:token'],
  [/^\/j\/[^/?]+/i, '/j/:token'],
  [/^\/invite\/[^/?]+/i, '/invite/:token'],
];

/** Query parameter names worth hiding the value of, whoever put them there. */
const SECRET_QUERY_KEY = /(token|secret|password|passwd|key|auth|credential|code|signature)/i;

/** JWT-shaped: three base64url segments starting with the `{"alg"` header. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Last line of defence, applied to the finished line. Nothing should reach here
 * that needs it — but "should" is doing a lot of work in a sentence about logs
 * and credentials, and this is three regexes.
 */
export function scrubSecrets(line: string): string {
  return line.replace(BEARER, 'Bearer [redacted]').replace(JWT_SHAPED, '[redacted]');
}

function redactQuery(search: string): string {
  return search
    .split('&')
    .map((pair) => {
      const equals = pair.indexOf('=');
      if (equals === -1) return pair;
      const key = pair.slice(0, equals);
      return SECRET_QUERY_KEY.test(key) ? `${key}=[redacted]` : pair;
    })
    .join('&');
}

/**
 * A URL that is safe to write down. Ids are kept — a line naming neither the
 * list nor the task is not worth the disk — and only the segments that are
 * bearer credentials in their own right are replaced.
 */
export function redactUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const search = queryAt === -1 ? '' : url.slice(queryAt + 1);

  let safe = path;
  for (const [pattern, replacement] of SECRET_PATH_SEGMENTS) {
    if (pattern.test(path)) {
      safe = path.replace(pattern, replacement);
      break;
    }
  }

  return search ? `${safe}?${redactQuery(search)}` : safe;
}

function levelFor(status: number): 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

/** One line, no newline. JSON in production; something readable otherwise. */
export function formatLogLine(entry: RequestLogEntry, format: LogFormat): string {
  const level = levelFor(entry.status);

  if (format === 'json') {
    // Assembled by hand rather than by spreading the entry, so a field can only
    // ever appear in a log line because someone put it here on purpose.
    const line: Record<string, unknown> = {
      time: entry.time,
      level,
      event: entry.event,
      method: entry.method,
      path: entry.path,
      status: entry.status,
    };
    if (entry.durationMs !== undefined) line.durationMs = entry.durationMs;
    if (entry.userId) line.userId = entry.userId;
    return scrubSecrets(JSON.stringify(line));
  }

  const parts = [entry.time, level, entry.method, entry.path, String(entry.status)];
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`);
  if (entry.userId) parts.push(`user=${entry.userId}`);
  if (entry.event !== 'request') parts.push(entry.event);
  return scrubSecrets(parts.join(' '));
}

export interface RequestLoggerOptions {
  format?: LogFormat;
  /** Where a finished line goes. Defaults to stdout, one line at a time. */
  write?: (line: string) => void;
  /** Monotonic milliseconds, for the duration. Injected by the tests. */
  monotonic?: () => number;
  /** Wall clock, for the timestamp. Injected by the tests. */
  wallClock?: () => Date;
  /**
   * Paths not worth a line when they succeed. The healthcheck is polled every
   * fifteen seconds, which is 5,760 lines a day that bury the ones that matter.
   * Failures are still logged — that is the one time it is interesting.
   */
  quietPaths?: readonly string[];
  /** Paths held open indefinitely, logged once when their headers go out. */
  streamPaths?: readonly string[];
}

const matchesPrefix = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

export function requestLogger(options: RequestLoggerOptions = {}): RequestHandler {
  const format = options.format ?? 'json';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const monotonic = options.monotonic ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => new Date());
  const quietPaths = options.quietPaths ?? ['/api/health'];
  const streamPaths = options.streamPaths ?? ['/api/stream'];

  return (req, res, next) => {
    const startedAt = monotonic();
    // Read now: Express rewrites req.url as it descends into mounted routers,
    // and by the time the response finishes it is relative to the last mount.
    const path = redactUrl(req.originalUrl || req.url);
    const method = req.method;

    const emit = (event: RequestLogEntry['event'], durationMs?: number) => {
      const status = res.statusCode;
      if (status < 400 && matchesPrefix(req.path, quietPaths)) return;
      write(
        formatLogLine(
          {
            event,
            time: wallClock().toISOString(),
            method,
            path,
            status,
            ...(durationMs === undefined ? {} : { durationMs }),
            // requireAuth runs after this middleware, so the user is only known
            // once the request is over.
            ...(req.user?.id ? { userId: req.user.id } : {}),
          },
          format,
        ),
      );
    };

    if (matchesPrefix(req.path, streamPaths)) {
      logOnceWhenHeadersGoOut(res, () => {
        // A stream that never opened — a 401, say — is an ordinary request that
        // finished, and its duration is both known and worth having.
        const opened = res.statusCode < 400;
        emit(
          opened ? 'stream.open' : 'request',
          opened ? undefined : Math.round(monotonic() - startedAt),
        );
      });
      next();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      emit('request', Math.round(monotonic() - startedAt));
    };
    // 'close' as well as 'finish', so a request the client abandoned still
    // leaves a trace rather than vanishing.
    res.on('finish', finish);
    res.on('close', finish);
    next();
  };
}

/**
 * Calls `log` the first time the response commits its status line, whether that
 * was `res.writeHead` (the SSE route) or an implicit header from `res.json`
 * (the 401 that never became a stream at all).
 */
function logOnceWhenHeadersGoOut(res: Response, log: () => void): void {
  // `writeHead` is overloaded three ways; forwarding the arguments untyped is
  // the honest version of "whatever they passed, pass it on".
  const original = res.writeHead as (...args: unknown[]) => Response;
  let logged = false;

  res.writeHead = function patched(this: Response, ...args: unknown[]): Response {
    const result = original.apply(this, args);
    if (!logged) {
      logged = true;
      log();
    }
    return result;
  } as unknown as Response['writeHead'];
}
