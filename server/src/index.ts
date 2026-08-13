import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startHeartbeat } from './events.js';
import { reportAuthMode } from './firebase.js';
import { migrate } from './migrate.js';

async function main(): Promise<void> {
  // Migrations finish before the port opens, so a rolling deploy never serves
  // traffic against a schema it doesn't expect.
  await migrate();
  reportAuthMode();

  const app = createApp();
  const heartbeat = startHeartbeat();

  const server = app.listen(config.port, () => {
    console.log(`[tally] listening on :${config.port} (${config.nodeEnv})`);
  });

  // SSE connections are long-lived by design; without this the process hangs
  // around waiting for them on shutdown and the orchestrator eventually kills it.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  const shutdown = async (signal: string) => {
    console.log(`[tally] ${signal} — shutting down`);
    clearInterval(heartbeat);
    server.closeAllConnections?.();
    server.close(() => void pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[tally] failed to start:', error);
  process.exit(1);
});
