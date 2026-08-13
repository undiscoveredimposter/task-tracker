/** Environment, read once and validated loudly rather than failing at first use. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  port: Number(optional('PORT', '8080')),
  databaseUrl: required('DATABASE_URL'),
  /** Public origin of the deployed app — used to build invite links. */
  appOrigin: optional('APP_ORIGIN', 'http://localhost:5173').replace(/\/+$/, ''),
  /** Where the built PWA lives. Empty disables static serving (useful in dev). */
  webRoot: optional('WEB_ROOT', ''),
  nodeEnv: optional('NODE_ENV', 'development'),
  firebase: {
    projectId: optional('FIREBASE_PROJECT_ID', ''),
    clientEmail: optional('FIREBASE_CLIENT_EMAIL', ''),
    // Coolify (and most dashboards) store multi-line secrets with literal \n.
    privateKey: optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
  },
  /** Default lifetime of an invite link. 0 means links never expire. */
  inviteDefaultDays: Number(optional('INVITE_DEFAULT_DAYS', '7')),
};

export const isProduction = config.nodeEnv === 'production';
