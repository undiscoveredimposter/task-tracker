import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from 'cors';
import express, { type Express } from 'express';
import { requireAuth } from './auth.js';
import { config } from './config.js';
import { errorHandler } from './errors.js';
import { subscriberCount } from './events.js';
import { pool } from './db.js';
import { inviteRouter, listInviteRouter } from './routes/invites.js';
import { listsRouter } from './routes/lists.js';
import { membersRouter } from './routes/members.js';
import { streamRouter } from './routes/stream.js';
import { tasksRouter } from './routes/tasks.js';

export function createApp(): Express {
  const app = express();

  // Coolify terminates TLS in front of us; trust its forwarded headers so
  // req.protocol and rate-limiting see the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, streams: subscriberCount() });
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
  app.use('/api/invites', inviteRouter);

  app.use('/api/lists/:id/invites', listInviteRouter);
  app.use('/api/lists/:id/members', requireAuth, membersRouter);
  app.use('/api/lists', requireAuth, listsRouter);
  app.use('/api/tasks', requireAuth, tasksRouter);
  app.use('/api/stream', requireAuth, streamRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such endpoint' });
  });

  // Serve the built PWA from the same origin, which keeps the API same-origin
  // and sidesteps CORS and third-party cookie behaviour entirely.
  if (config.webRoot && existsSync(config.webRoot)) {
    const indexHtml = join(config.webRoot, 'index.html');

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
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler);
  return app;
}
