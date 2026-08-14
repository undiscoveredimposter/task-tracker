/** Environment, read once and validated loudly rather than failing at first use. */

import { resolveWebRoot } from './web-root.js';

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

export const config = {
  port: Number(optional('PORT', '8080')),
  databaseUrl: required('DATABASE_URL'),
  /** Public origin of the deployed app — used to build invite links. */
  appOrigin: optional('APP_ORIGIN', 'http://localhost:5173').replace(/\/+$/, ''),
  /**
   * Where the built PWA lives, as an absolute path. Empty disables static
   * serving (useful in dev). A relative WEB_ROOT is resolved against the working
   * directory once, here, so `existsSync`, `express.static` and `res.sendFile`
   * cannot disagree about which directory it meant — see web-root.ts.
   */
  webRoot: resolveWebRoot(optional('WEB_ROOT', '')),
  nodeEnv: optional('NODE_ENV', 'development'),
  firebase: {
    projectId: optional('FIREBASE_PROJECT_ID', ''),
    clientEmail: optional('FIREBASE_CLIENT_EMAIL', ''),
    // Coolify (and most dashboards) store multi-line secrets with literal \n.
    privateKey: optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
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
};

export const isProduction = config.nodeEnv === 'production';
