import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerEvent } from '@tally/shared';
import {
  NOTIFY_PAYLOAD_BUDGET,
  NOTIFY_PAYLOAD_LIMIT,
  PayloadTooLargeError,
  compactEvent,
  decodeEnvelope,
  encodeEnvelope,
  isValidChannelName,
  type EventEnvelope,
} from '../src/event-wire.ts';

const completed: ServerEvent = {
  type: 'task.completed',
  listId: 'list-1',
  taskId: 'task-1',
  periodKey: 'd:2026-08-13',
  completion: {
    at: '2026-08-13T08:12:00.000Z',
    by: { id: 'user-1', displayName: 'Alex', email: 'alex@example.test', photoUrl: null },
  },
};

const envelope = (event: ServerEvent, extra: Partial<EventEnvelope> = {}): EventEnvelope => ({
  v: 1,
  origin: 'instance-a',
  listId: 'list-1',
  event,
  except: null,
  ...extra,
});

describe('event envelope encoding', () => {
  it('round-trips an event through the wire format', () => {
    const decoded = decodeEnvelope(encodeEnvelope(envelope(completed, { except: 'user-1' })));

    assert.deepEqual(decoded, envelope(completed, { except: 'user-1' }));
  });

  it('keeps the small events verbatim', () => {
    const changed: ServerEvent = { type: 'task.changed', listId: 'list-1' };

    assert.deepEqual(decodeEnvelope(encodeEnvelope(envelope(changed)))?.event, changed);
  });

  it('stays under the budget, which stays under what Postgres accepts', () => {
    assert.ok(NOTIFY_PAYLOAD_BUDGET < NOTIFY_PAYLOAD_LIMIT);
    assert.equal(NOTIFY_PAYLOAD_LIMIT, 8000);

    const payload = encodeEnvelope(envelope(completed));
    assert.ok(Buffer.byteLength(payload) < NOTIFY_PAYLOAD_BUDGET);
  });

  /**
   * The size ceiling is the whole reason the client is told to refetch rather
   * than trusting the payload. A display name or photo URL is user-controlled,
   * so "events are small" is an assumption, not a guarantee.
   */
  it('degrades an oversized event to an identifier the client can refetch from', () => {
    const huge: ServerEvent = {
      ...completed,
      completion: {
        ...completed.completion,
        by: { ...completed.completion.by, photoUrl: `https://example.test/${'p'.repeat(9000)}` },
      },
    };

    const payload = encodeEnvelope(envelope(huge));
    assert.ok(Buffer.byteLength(payload) < NOTIFY_PAYLOAD_LIMIT);

    const decoded = decodeEnvelope(payload);
    assert.deepEqual(decoded?.event, { type: 'task.changed', listId: 'list-1' });
    // The routing fields survive: the recipients are still resolved correctly.
    assert.equal(decoded?.listId, 'list-1');
    assert.equal(decoded?.origin, 'instance-a');
  });

  it('refuses rather than letting Postgres reject the NOTIFY', () => {
    assert.throws(
      () => encodeEnvelope(envelope({ type: 'task.changed', listId: 'l'.repeat(9000) })),
      PayloadTooLargeError,
    );
  });

  it('compacts only the events that carry a body', () => {
    assert.deepEqual(compactEvent(completed), { type: 'task.changed', listId: 'list-1' });
    assert.deepEqual(
      compactEvent({
        type: 'task.uncompleted',
        listId: 'list-1',
        taskId: 'task-1',
        periodKey: 'd:2026-08-13',
      }),
      { type: 'task.changed', listId: 'list-1' },
    );

    const membersChanged: ServerEvent = { type: 'members.changed', listId: 'list-1' };
    assert.deepEqual(compactEvent(membersChanged), membersChanged);
  });
});

describe('event envelope decoding', () => {
  /**
   * A payload arrives from the database rather than from a browser, but it is
   * still input from outside this process — a stale instance mid-deploy, or
   * anything else with the connection string, can put bytes on the channel.
   */
  it('rejects anything it cannot vouch for', () => {
    assert.equal(decodeEnvelope('not json at all'), null);
    assert.equal(decodeEnvelope('null'), null);
    assert.equal(decodeEnvelope('[]'), null);
    assert.equal(decodeEnvelope(JSON.stringify({ v: 1, origin: 'a', listId: 'l' })), null);
  });

  it('rejects an unknown event type rather than forwarding it to a browser', () => {
    const raw = JSON.stringify({
      v: 1,
      origin: 'a',
      listId: 'list-1',
      except: null,
      event: { type: 'task.exploded', listId: 'list-1' },
    });

    assert.equal(decodeEnvelope(raw), null);
  });

  it('rejects a version it does not understand', () => {
    const raw = JSON.stringify({
      v: 2,
      origin: 'a',
      listId: 'list-1',
      except: null,
      event: { type: 'task.changed', listId: 'list-1' },
    });

    assert.equal(decodeEnvelope(raw), null);
  });
});

/**
 * A channel name cannot be a bound parameter — `LISTEN` takes an identifier —
 * so the only defence is refusing to accept one that isn't plainly safe.
 */
describe('channel names', () => {
  it('accepts a plain lower-case identifier', () => {
    assert.equal(isValidChannelName('tally_events'), true);
    assert.equal(isValidChannelName('_events2'), true);
  });

  it('rejects anything that would need quoting or escaping', () => {
    assert.equal(isValidChannelName(''), false);
    assert.equal(isValidChannelName('tally events'), false);
    assert.equal(isValidChannelName('Tally_Events'), false);
    assert.equal(isValidChannelName('tally"; DROP TABLE users; --'), false);
    assert.equal(isValidChannelName('2events'), false);
    assert.equal(isValidChannelName('e'.repeat(64)), false);
  });
});
