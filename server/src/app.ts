import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import { requireAuth } from './auth.js';
import { config, isProduction } from './config.js';
import { errorHandler } from './errors.js';
import { eventListenerState, subscriberCount } from './events.js';
import { pool } from './db.js';
import { writeLimiter } from './limits.js';
import { requestLogger } from './request-log.js';
import { inlineScriptHashes, securityHeaders } from './security-headers.js';
import { inviteRouter, listInviteRouter } from './routes/invites.js';
import { listsRouter } from './routes/lists.js';
import { membersRouter } from './routes/members.js';
import { streamRouter } from './routes/stream.js';
import { tasksRouter } from './routes/tasks.js';

/**
 * CSP hashes for the inline `<script>` blocks in the shell we are actually
 * serving. Read once at startup from the built file rather than kept as a
 * constant, so the frontend can change its pre-paint theme script without a
 * matching edit here — and without a blank screen if nobody makes one.
 */
function shellScriptHashes(webRoot: string): string[] {
  const indexHtml = join(webRoot, 'index.html');
  if (!existsSync(indexHtml)) return [];
  return inlineScriptHashes(readFileSync(indexHtml, 'utf8'));
}

export function createApp(): Express {
  const app = express();

  // Coolify terminates TLS in front of us; trust its forwarded headers so
  // req.protocol and rate-limiting see the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Outermost, so a request is timed end to end and a response that never
  // reaches a route still leaves a line.
  app.use(requestLogger({ format: config.logFormat }));

  app.use(
    securityHeaders({
      authDomains: config.firebase.authDomains,
      scriptHashes: config.webRoot ? shellScriptHashes(config.webRoot) : [],
      reportOnly: config.cspReportOnly,
      // Only meaningful once TLS is terminated in front of us, and only sent on
      // requests that actually arrived over https — see security-headers.ts.
      hsts: isProduction,
      upgradeInsecureRequests: isProduction,
    }),
  );

  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '64kb' }));

  // Mounted ahead of every limiter: Coolify polls this every 15 seconds and a
  // 429 here would look like a sick container and take the app out of rotation.
  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      // `live` is the LISTEN connection. Anything but `listening` means this
      // instance is deaf to events raised on another one — still a working app
      // for anybody connected here, but not a healthy member of a pair. Kept
      // out of `ok` on purpose: taking the container out of rotation for it
      // would make a database blip into an outage.
      res.json({ ok: true, streams: subscriberCount(), live: eventListenerState() });
    } catch {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const user = req.user!;
    res.json({
      id: user.id,
      displayName: user.displayName,
      email: user.email,
      photoUrl: user.photoUrl,
    });
  });

  // The invite preview is deliberately outside requireAuth — someone opening a
  // link before signing in still needs to see what they've been invited to.
  // That makes it the one unlocked door, so it carries its own limiter; see
  // routes/invites.ts.
  app.use('/api/invites', inviteRouter);

  // `writeLimiter` goes after `requireAuth` on each mount so it can charge the
  // request to the person rather than to the household's shared address. It
  // skips reads, so the GETs on these routers are untouched.
  app.use('/api/lists/:id/invites', listInviteRouter);
  app.use('/api/lists/:id/members', requireAuth, writeLimiter, membersRouter);
  app.use('/api/lists', requireAuth, writeLimiter, listsRouter);
  app.use('/api/tasks', requireAuth, writeLimiter, tasksRouter);
  app.use('/api/stream', requireAuth, streamRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such endpoint' });
  });

  // Serve the built PWA from the same origin, which keeps the API same-origin
  // and sidesteps CORS and third-party cookie behaviour entirely.
  //
  // config.webRoot is absolute by the time it gets here; express.static and
  // res.sendFile disagree about relative paths, and the disagreement showed up
  // as a server that served every asset and 500'd every page navigation.
  const webRootExists = config.webRoot !== '' && existsSync(config.webRoot);

  if (config.webRoot && !webRootExists) {
    // The healthcheck only touches /api/health, so nothing else would say this
    // out loud: the container would come up green and serve no pages at all.
    console.warn(
      `[tally] WEB_ROOT is set to ${config.webRoot}, which does not exist — serving the API only`,
    );
  }

  if (webRootExists) {
    app.use(
      express.static(config.webRoot, {
        index: false,
        setHeaders(res, path) {
          // Hashed assets are immutable; the shell and the service worker must
          // never be, or a deploy can't reach a device that already has them.
          if (path.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (path.endsWith('sw.js') || path.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );

    // SPA fallback as a bare middleware rather than a wildcard route — Express 5
    // is strict about path syntax and this needs no pattern at all.
    //
    // Sent relative to `root` rather than as one absolute path: with no root,
    // send() applies its dotfile rule to every segment of the path it is given,
    // including the ones we chose, so an app installed anywhere under a
    // dot-directory — /srv/.deploy, a git worktree under .claude, ~/.cache —
    // answers every page navigation with a 404 while still serving its assets.
    // With a root, the rule covers only the part a request can influence.
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile('index.html', { root: config.webRoot });
    });
  }

  app.use(errorHandler);
  return app;
}
