import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

/**
 * Security response headers, worked out as data so they can be asserted on
 * without a server.
 *
 * The Content-Security-Policy is the part that can break the app rather than
 * protect it: Firebase Auth loads a script from apis.google.com, frames the
 * project's auth domain, and talks to two Google endpoints. Deny any of those
 * and Google sign-in fails while everything else keeps working, which is the
 * kind of bug that ships. Every allowance below is there for a named reason.
 *
 * Firebase's own documented policy is the baseline:
 *   script-src  'self' https://apis.google.com
 *   frame-src   'self' https://<project>.firebaseapp.com
 *   connect-src 'self' https://identitytoolkit.googleapis.com
 *                      https://securetoken.googleapis.com
 */

export interface SecurityPolicyOptions {
  /**
   * Firebase Auth domains to allow as frame sources. Usually one — either
   * `<projectId>.firebaseapp.com` or a custom domain.
   */
  authDomains?: readonly string[];
  /**
   * CSP source expressions for the inline `<script>` blocks in the served
   * index.html, e.g. `'sha256-…'`. Computed from the file we actually serve, so
   * the frontend can change its inline script without anybody remembering to
   * update a policy here.
   */
  scriptHashes?: readonly string[];
  /** Send the policy as `Content-Security-Policy-Report-Only`. */
  reportOnly?: boolean;
  /** Send HSTS. Only ever has an effect on requests that arrived over TLS. */
  hsts?: boolean;
  /** Add `upgrade-insecure-requests`. Off in development, which is plain http. */
  upgradeInsecureRequests?: boolean;
}

/**
 * Two years, the value HSTS preload lists expect.
 *
 * `preload` itself is deliberately not sent: it is close to irreversible and
 * should be an explicit decision, not a side effect of deploying.
 *
 * `includeSubDomains` is still wide, and worth being honest about. It applies to
 * the entire domain the response came from, so deploying at an apex forces https
 * on every sibling subdomain for two years — see the HSTS block in
 * docker-compose.yml, which is where an operator picks the domain. Deploying at
 * a subdomain keeps it to that subtree, which is what this is tuned for.
 *
 * Sent only on requests that actually arrived over TLS (see below), so a local
 * http run can never poison a developer's browser.
 */
const HSTS = 'max-age=63072000; includeSubDomains';

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

const FIREBASE_SCRIPT_SRC = 'https://apis.google.com';
const FIREBASE_CONNECT_SRC = [
  'https://identitytoolkit.googleapis.com',
  // The hourly ID-token refresh. Blocking it looks like a working sign-in that
  // silently logs everybody out an hour later.
  'https://securetoken.googleapis.com',
];

function serialise(directives: Record<string, string[] | null>): string {
  return Object.entries(directives)
    .filter(([, values]) => values !== null)
    .map(([name, values]) => (values!.length ? `${name} ${values!.join(' ')}` : name))
    .join('; ');
}

/** The policy for the PWA itself — the app shell, its assets and its SPA routes. */
export function appContentSecurityPolicy(options: SecurityPolicyOptions): string {
  const frames = (options.authDomains ?? []).map((domain) => `https://${domain}`);

  return serialise({
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': ["'self'", FIREBASE_SCRIPT_SRC, ...(options.scriptHashes ?? [])],
    // Hashing would be nicer, but React writes element styles at runtime and
    // Tailwind's build can inline a style block. Inline *styles* cannot exfiltrate
    // data the way inline scripts can, so this is the cheap half of the trade.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Avatars come from the identity provider's CDN, whichever one that is:
    // lh3.googleusercontent.com today, something else the moment another sign-in
    // method is enabled. Images are the lowest-risk thing to be broad about.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...FIREBASE_CONNECT_SRC],
    // The hidden iframe behind signInWithPopup and signInWithRedirect.
    'frame-src': ["'self'", ...frames],
    'worker-src': ["'self'"],
    'manifest-src': ["'self'"],
    'upgrade-insecure-requests': options.upgradeInsecureRequests ? [] : null,
  });
}

/**
 * The policy for `/api`. Nothing legitimately renders from a JSON response, so
 * it gets the strictest policy there is rather than the app's.
 */
export const API_CONTENT_SECURITY_POLICY: string = serialise({
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
});

/**
 * CSP `'sha256-…'` sources for every inline `<script>` in an HTML document.
 *
 * A browser hashes the exact bytes between the tags, so this must not trim or
 * normalise: a hash computed from tidied-up source never matches, and the theme
 * script that runs before first paint would be blocked — a white flash on every
 * launch for anyone who chose dark.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    // External scripts are covered by 'self'; hashing them would do nothing.
    if (/\bsrc\s*=/i.test(attributes)) continue;
    if (!body.trim()) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }

  return [...hashes];
}

/**
 * The Firebase Auth domains to allow, given what the server knows.
 *
 * The web build's `VITE_FIREBASE_AUTH_DOMAIN` is inlined at build time and never
 * reaches the server, so the ordinary case is derived from the project id the
 * server already needs for token verification. A custom auth domain has to be
 * given explicitly, via FIREBASE_AUTH_DOMAIN.
 */
export function firebaseAuthDomains(projectId: string, authDomain: string): string[] {
  const explicit = authDomain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const derived = projectId.trim() ? `${projectId.trim()}.firebaseapp.com` : '';
  return [...new Set([explicit, derived].filter(Boolean))];
}

/** `/api` and its children, but not `/apiary`. */
export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** The headers to set for one request. Pure; the middleware is the wrapper below. */
export function securityHeadersFor(
  options: SecurityPolicyOptions,
  request: { path: string; secure: boolean },
): Record<string, string> {
  const policy = isApiPath(request.path)
    ? API_CONTENT_SECURITY_POLICY
    : appContentSecurityPolicy(options);

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    // Cross-origin requests get the origin only, so an invite token sitting in
    // the path of /j/<token> can never travel in a Referer header. Same-origin
    // navigation still sees the full URL.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    // NOT 'same-origin': that severs window.opener and signInWithPopup hangs on
    // a blank Google page forever. Cross-Origin-Embedder-Policy is left unset for
    // the same reason — require-corp breaks the Firebase auth iframe.
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'X-Permitted-Cross-Domain-Policies': 'none',
    [options.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']: policy,
  };

  // Never over plaintext: a max-age set from a local http run would lock a
  // developer out of http://localhost for two years, and browsers ignore it
  // there anyway.
  if (options.hsts && request.secure) headers['Strict-Transport-Security'] = HSTS;

  return headers;
}

/**
 * Sets those headers on every response. The four possible header sets are built
 * once at startup rather than per request — they only vary by "is this /api?"
 * and "did this arrive over TLS?".
 */
export function securityHeaders(options: SecurityPolicyOptions = {}): RequestHandler {
  const variant = (path: string, secure: boolean) =>
    Object.entries(securityHeadersFor(options, { path, secure }));

  const sets = {
    api: { plain: variant('/api/', false), secure: variant('/api/', true) },
    app: { plain: variant('/', false), secure: variant('/', true) },
  };

  return (req, res, next) => {
    // `req.secure` follows X-Forwarded-Proto because app.ts trusts one proxy hop.
    const chosen = isApiPath(req.path) ? sets.api : sets.app;
    for (const [name, value] of req.secure ? chosen.secure : chosen.plain) {
      res.setHeader(name, value);
    }
    next();
  };
}
