import { Router } from 'express';
import { authed } from '../auth.js';
import { addSubscriber, sendTo } from '../events.js';

export const streamRouter: Router = Router();

/**
 * One long-lived SSE connection per signed-in device. Every list the user
 * belongs to shares it — the client routes events by `listId` — so opening a
 * second list doesn't open a second socket.
 */
streamRouter.get('/', (req, res) => {
  const user = authed(req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Tells nginx (and Coolify's proxy) not to buffer, which would otherwise
    // hold events back until the response looked "big enough" to flush.
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  // Reconnect delay the browser should use if the stream drops.
  res.write('retry: 3000\n\n');

  const remove = addSubscriber(user.id, res);
  sendTo(user.id, { type: 'hello', userId: user.id });

  req.on('close', () => {
    remove();
    res.end();
  });
});
