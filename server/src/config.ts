/** Environment, read once and validated loudly rather than failing at first use. */

import { firebaseAuthDomains } from './security-headers.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

/**
 * A count that must be above zero. A rate limit of 0 would lock everyone out of
 * their own list, so a typo in the environment fails at boot rather than turning
 * the app into a wall of 429s that nobody can explain.
 */
function positive(name: string, fallback: string): number {
  const value = Number(optional(name, fallback));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(process.env[name])}`);
  }
  return value;
}

/** An opt-in flag. Anything but `1`/`true`/`yes` is off. */
function flag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

// Hoisted because a couple of defaults below depend on it, and an object
// literal cannot refer to its own fields.
const nodeEnv = optional('NODE_ENV', 'development');
const firebaseProjectId = optional('FIREBASE_PROJECT_ID', '');

export const config = {
  port: Number(optional('PORT', '8080')),
  databaseUrl: required('DATABASE_URL'),
  /** Public origin of the deployed app — used to build invite links. */
  appOrigin: optional('APP_ORIGIN', 'http://localhost:5173').replace(/\/+$/, ''),
  /** Where the built PWA lives. Empty disables static serving (useful in dev). */
  webRoot: optional('WEB_ROOT', ''),
  nodeEnv,
  firebase: {
    projectId: firebaseProjectId,
    clientEmail: optional('FIREBASE_CLIENT_EMAIL', ''),
    // Coolify (and most dashboards) store multi-line secrets with literal \n.
    privateKey: optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
    /**
     * The domain Firebase Auth serves its sign-in iframe from, which the CSP has
     * to allow as a frame source or Google sign-in fails and nothing else does.
     *
     * The web build has this as VITE_FIREBASE_AUTH_DOMAIN, but Vite inlines that
     * at build time and it never reaches the server, so the default is derived
     * from the project id. Set FIREBASE_AUTH_DOMAIN only if you use a custom
     * auth domain — and if you do, it must match what the web build was given.
     */
    authDomains: firebaseAuthDomains(firebaseProjectId, optional('FIREBASE_AUTH_DOMAIN', '')),
  },
  /** Default lifetime of an invite link. 0 means links never expire. */
  inviteDefaultDays: Number(optional('INVITE_DEFAULT_DAYS', '7')),

  /** Request budgets, per minute. See rate-limit.ts and limits.ts. */
  rateLimit: {
    /**
     * Unauthenticated invite-link lookups, per client address. Opening a link
     * costs two requests (preview, then accept), so twenty is a household
     * passing one link round several times over and still not noticing.
     */
    inviteLookupsPerMinute: positive('RATE_LIMIT_INVITE_LOOKUPS_PER_MINUTE', '20'),
    /**
     * Authenticated writes, per signed-in person. Loose on purpose — this is a
     * backstop against a runaway client, not a quota. Nobody ticks four things
     * a second by hand.
     */
    writesPerMinute: positive('RATE_LIMIT_WRITES_PER_MINUTE', '240'),
  },

  /**
   * Send the Content-Security-Policy as `Content-Security-Policy-Report-Only`,
   * so a policy that would break sign-in reports instead of breaking it. Meant
   * for the first deploy of a policy change, not as a resting state.
   *
   * Read this before you rely on it: we send no `report-uri` and no `report-to`,
   * so a violation is printed to the console of the browser that hit it and goes
   * nowhere else. Nothing reaches this server and nothing reaches your logs. A
   * quiet week of server logs is therefore *no evidence at all* that the policy
   * is clean — it is only evidence that nobody was looking. The only way to
   * check is to open devtools on a real sign-in, on each of the three methods,
   * and read the console yourself.
   *
   * Because of that, leaving this on indefinitely is the worst of both worlds:
   * the policy is unenforced and unobserved. Turn it on for a deploy, check the
   * three sign-in paths by hand, turn it back off.
   */
  cspReportOnly: flag('CSP_REPORT_ONLY'),

  /** `json` or `text`. Defaults to json in production, readable elsewhere. */
  logFormat: (optional('LOG_FORMAT', nodeEnv === 'production' ? 'json' : 'text') === 'json'
    ? 'json'
    : 'text') as 'json' | 'text',
};

export const isProduction = config.nodeEnv === 'production';
