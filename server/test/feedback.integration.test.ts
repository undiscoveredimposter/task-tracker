import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SKIP_REASON, startHarness, type Harness, type TestUser } from './helpers/harness.ts';

/**
 * `POST /api/feedback` end to end, with GitHub stood in for: the global `fetch`
 * is wrapped so a request to api.github.com is answered here, and everything
 * else — the test clients talking to the app — goes through untouched.
 *
 * What it pins down is the edge the unit tests can't see: that the route is
 * behind sign-in, has its own small budget, and sends GitHub what feedback.ts
 * rendered — with nothing about the person who sent it.
 */

interface GitHubCall {
  url: string;
  authorization: string | null;
  body: { title: string; body: string; labels: string[] };
}

describe('POST /api/feedback', { skip: SKIP_REASON }, () => {
  let h: Harness;
  let alex: TestUser;
  let gitHubCalls: GitHubCall[];
  let gitHubStatus: number;
  const realFetch = globalThis.fetch;

  before(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
      gitHubCalls.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ number: 101 }), { status: gitHubStatus });
    }) as typeof fetch;

    h = await startHarness({
      env: {
        GITHUB_FEEDBACK_TOKEN: 'ghp_test_token',
        GITHUB_FEEDBACK_REPO: 'owner/repo',
        RATE_LIMIT_FEEDBACK_PER_HOUR: '3',
      },
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await h?.close();
  });

  beforeEach(async () => {
    await h.truncate();
    gitHubCalls = [];
    gitHubStatus = 201;
    // A fresh person each time: the budget is per person and in memory, so it
    // would otherwise carry over from one test to the next.
    alex = await h.signIn(`alex-${Math.random().toString(36).slice(2, 8)}`);
  });

  it('opens an issue on the configured repository and answers 204', async () => {
    const response = await alex.post('/api/feedback', {
      kind: 'idea',
      message: 'Let me pick a reset hour per task',
      screen: '/l/abc',
    });

    assert.equal(response.status, 204);
    assert.equal(gitHubCalls.length, 1);
    const [call] = gitHubCalls;
    assert.equal(call!.url, 'https://api.github.com/repos/owner/repo/issues');
    assert.equal(call!.authorization, 'Bearer ghp_test_token');
    assert.deepEqual(call!.body.labels, ['feedback', 'status:triage']);
    assert.match(call!.body.title, /^Feedback \(idea\): Let me pick a reset hour per task$/);
  });

  it('leaves the sender out of what GitHub receives', async () => {
    await alex.post('/api/feedback', { kind: 'bug', message: 'Ticks vanish', email: alex.email });
    const sent = JSON.stringify(gitHubCalls[0]!.body);
    assert.ok(!sent.includes(alex.email), 'email');
    assert.ok(!sent.includes(alex.uid), 'firebase uid');
    assert.ok(!sent.includes(alex.id), 'user id');
  });

  it('needs a signed-in person', async () => {
    const response = await h.anonymous().post('/api/feedback', { kind: 'idea', message: 'hi' });
    assert.equal(response.status, 401);
    assert.equal(gitHubCalls.length, 0);
  });

  it('refuses an empty message without calling GitHub', async () => {
    const response = await alex.post('/api/feedback', { kind: 'idea', message: '   ' });
    assert.equal(response.status, 400);
    assert.equal(gitHubCalls.length, 0);
  });

  it('answers 502 with a readable message when GitHub refuses', async () => {
    gitHubStatus = 401;
    const response = await alex.post('/api/feedback', { kind: 'idea', message: 'hi' });
    assert.equal(response.status, 502);
    assert.match(response.body.error, /couldn't be sent/);
    assert.ok(!JSON.stringify(response.body).includes('ghp_test_token'));
  });

  it('has its own budget, per person', async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await alex.post('/api/feedback', { kind: 'other', message: `n${i}` })).status, 204);
    }
    const refused = await alex.post('/api/feedback', { kind: 'other', message: 'one too many' });
    assert.equal(refused.status, 429);
    assert.equal(gitHubCalls.length, 3);

    // Somebody else in the same household is not charged for it.
    const sam = await h.signIn(`sam-${Math.random().toString(36).slice(2, 8)}`);
    assert.equal((await sam.post('/api/feedback', { kind: 'other', message: 'mine' })).status, 204);
  });
});
