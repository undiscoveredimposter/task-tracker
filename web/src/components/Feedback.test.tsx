import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackButton } from './Feedback';

/**
 * The feedback sheet is a form whose only output is one request, so that is
 * what these look at: what goes out, that nothing goes out empty, and that a
 * refusal ends up on screen instead of being swallowed.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let reply: () => Response;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls = [];
  reply = () => new Response(null, { status: 204 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    return reply();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function open(path = '/l/abc') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <FeedbackButton />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }));
}

const messageBox = () => screen.getByRole('textbox');
const sendButton = () => screen.getByRole('button', { name: 'Send' });

describe('FeedbackButton', () => {
  it('opens a sheet that says the feedback is public', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeTruthy();
    expect(screen.getByText(/posted publicly on GitHub/)).toBeTruthy();
  });

  it('will not send an empty message', () => {
    open();
    expect(sendButton()).toHaveProperty('disabled', true);
    fireEvent.change(messageBox(), { target: { value: '   ' } });
    expect(sendButton()).toHaveProperty('disabled', true);
  });

  it('sends the kind, the message and the screen it was opened on', async () => {
    open('/l/abc/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Bug' }));
    fireEvent.change(messageBox(), { target: { value: 'Ticks vanish after midnight' } });
    fireEvent.click(sendButton());

    await screen.findByText(/Got it/);
    expect(calls).toEqual([
      {
        url: '/api/feedback',
        method: 'POST',
        body: { kind: 'bug', message: 'Ticks vanish after midnight', screen: '/l/abc/settings' },
      },
    ]);
  });

  it('marks the chosen kind as pressed and changes the question to match', () => {
    open();
    expect(screen.getByRole('button', { name: 'Idea' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Bug' }));
    expect(screen.getByRole('button', { name: 'Bug' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('What went wrong?')).toBeTruthy();
  });

  it('shows the server’s refusal and keeps what was written', async () => {
    reply = () => json({ error: "Your feedback couldn't be sent just now. Try again in a bit." }, 502);
    open();
    fireEvent.change(messageBox(), { target: { value: 'More colours please' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/couldn't be sent/));
    expect((messageBox() as HTMLTextAreaElement).value).toBe('More colours please');
  });
});
