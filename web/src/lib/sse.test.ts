import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

const parser = () => new SseParser();

describe('SseParser', () => {
  it('reads a complete event', () => {
    const events = parser().push('data: {"type":"hello","userId":"alex"}\n\n');
    expect(events).toEqual([{ type: 'hello', userId: 'alex' }]);
  });

  it('waits for the blank line before emitting', () => {
    const p = parser();
    expect(p.push('data: {"type":"hello","userId":"alex"}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ type: 'hello', userId: 'alex' }]);
  });

  it('reassembles an event split across chunks mid-JSON', () => {
    // Chunk boundaries fall wherever the network decides, not on event edges.
    const p = parser();
    expect(p.push('data: {"type":"task.un')).toEqual([]);
    expect(p.push('completed","listId":"l1",')).toEqual([]);
    const events = p.push('"taskId":"t1","periodKey":"d:2026-08-13"}\n\n');
    expect(events).toEqual([
      { type: 'task.uncompleted', listId: 'l1', taskId: 't1', periodKey: 'd:2026-08-13' },
    ]);
  });

  it('reads several events arriving in one chunk', () => {
    const events = parser().push(
      'data: {"type":"list.changed","listId":"a"}\n\ndata: {"type":"list.changed","listId":"b"}\n\n',
    );
    expect(events.map((e) => 'listId' in e && e.listId)).toEqual(['a', 'b']);
  });

  it('ignores heartbeat comments', () => {
    // The server sends ": ping" every 25s to stop proxies closing the stream.
    const p = parser();
    expect(p.push(': ping\n\n')).toEqual([]);
    expect(p.push('data: {"type":"hello","userId":"alex"}\n\n')).toHaveLength(1);
  });

  it('ignores the retry directive', () => {
    expect(parser().push('retry: 3000\n\n')).toEqual([]);
  });

  it('joins a data field spread over several lines', () => {
    const events = parser().push('data: {"type":"hello",\ndata: "userId":"alex"}\n\n');
    expect(events).toEqual([{ type: 'hello', userId: 'alex' }]);
  });

  it('skips a malformed event rather than throwing away the stream', () => {
    const p = parser();
    expect(p.push('data: not json at all\n\n')).toEqual([]);
    expect(p.push('data: {"type":"hello","userId":"alex"}\n\n')).toHaveLength(1);
  });

  it('tolerates CRLF line endings from a proxy that rewrites them', () => {
    const events = parser().push('data: {"type":"hello","userId":"alex"}\r\n\r\n');
    expect(events).toEqual([{ type: 'hello', userId: 'alex' }]);
  });

  it('copes with data lines that have no space after the colon', () => {
    const events = parser().push('data:{"type":"hello","userId":"alex"}\n\n');
    expect(events).toEqual([{ type: 'hello', userId: 'alex' }]);
  });
});
