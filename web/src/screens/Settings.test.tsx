import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListSummary, Me } from '@tally/shared';
import { Settings } from './Settings';

/**
 * Renaming yourself and deleting yourself sit one press apart on this screen,
 * and neither is a pure function: what matters is which request goes out, that
 * the destructive one does not go out until it has been confirmed, and that a
 * refusal ends up on screen rather than being swallowed. None of that is visible
 * from `draftName` — profile.test.ts covers the parts that are.
 */

const alex: Me = { id: 'alex', displayName: 'Alex', email: 'alex@example.com', photoUrl: null };

let auth: {
  loading: boolean;
  firebaseUser: null;
  me: Me | null;
  error: null;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};
let lists: ListSummary[];

/* The provider behind each of these holds a Firebase session and a live stream
   open; neither is what this screen is made of. */
vi.mock('../lib/auth', () => ({ useAuth: () => auth }));
vi.mock('../lib/store', () => ({ useData: () => ({ lists }) }));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
/** What the next request comes back as. Replaced by the tests wanting a refusal. */
let reply: () => Response;

const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  auth = {
    loading: false,
    firebaseUser: null,
    error: null,
    me: alex,
    signOut: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  };
  lists = [];
  calls = [];
  reply = () => json(alex);

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

const mount = () =>
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );

const nameField = () => screen.getByLabelText('Short name') as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: /^saved?( name)?$/i }) as HTMLButtonElement;
const alertText = async () => (await screen.findByRole('alert')).textContent;

describe('the short name', () => {
  it('starts as the name other people already see', () => {
    mount();
    expect(nameField().value).toBe('Alex');
  });

  it('cannot be saved until it is actually different', () => {
    mount();
    expect(saveButton().disabled).toBe(true);

    // Padding is not a change: the server trims before it stores.
    fireEvent.change(nameField(), { target: { value: '  Alex  ' } });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(nameField(), { target: { value: 'Al' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('cannot be saved empty', () => {
    mount();
    fireEvent.change(nameField(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
  });

  it('goes to PATCH /api/me trimmed, and the profile is re-read after', async () => {
    mount();
    fireEvent.change(nameField(), { target: { value: '  Alexandra  ' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(auth.refresh).toHaveBeenCalled());
    expect(calls).toEqual([{ url: '/api/me', method: 'PATCH', body: { displayName: 'Alexandra' } }]);
  });

  it('shows what the server refused, and keeps what was typed', async () => {
    reply = () => json({ error: 'A name cannot contain line breaks' }, 400);
    mount();

    fireEvent.change(nameField(), { target: { value: 'Alexandra' } });
    fireEvent.click(saveButton());

    expect(await alertText()).toContain('A name cannot contain line breaks');
    expect(nameField().value).toBe('Alexandra');
    expect(auth.refresh).not.toHaveBeenCalled();
  });
});

describe('deleting your profile', () => {
  // Exact names, not patterns: the sheet's own close button is called
  // "Close Delete your profile?", which a loose match would also find.
  const ask = () => fireEvent.click(screen.getByRole('button', { name: 'Delete your profile' }));
  const confirmButton = () => screen.queryByRole('button', { name: 'Yes, delete my profile' });

  it('asks before it does anything', () => {
    mount();
    ask();

    // Nothing has left the device — opening the sheet is the whole of what happened.
    expect(calls).toEqual([]);
    expect(confirmButton()).not.toBeNull();
  });

  it('names the lists that go with the account', () => {
    lists = [
      { name: 'Home', role: 'owner' } as ListSummary,
      { name: 'Flat admin', role: 'owner' } as ListSummary,
      { name: 'Plants', role: 'viewer' } as ListSummary,
    ];
    mount();
    ask();

    const sheet = screen.getByRole('dialog').textContent ?? '';
    expect(sheet).toContain('Home and Flat admin are deleted for everyone on them.');
    // A list someone else owns is not yours to take away.
    expect(sheet).not.toContain('Plants');
  });

  it('backing out sends nothing', () => {
    mount();
    ask();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(calls).toEqual([]);
    expect(confirmButton()).toBeNull();
  });

  it('confirming deletes the account and then signs the device out', async () => {
    reply = () => new Response(null, { status: 204 });
    mount();
    ask();
    fireEvent.click(confirmButton()!);

    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(calls).toEqual([{ url: '/api/me', method: 'DELETE', body: null }]);
  });

  it('stays put and says why when the delete is refused', async () => {
    reply = () => json({ error: 'Your account could not be deleted' }, 500);
    mount();
    ask();
    fireEvent.click(confirmButton()!);

    expect(await alertText()).toContain('Your account could not be deleted');
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe('signing out', () => {
  it('is here rather than under the avatar, and only signs out', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    expect(calls).toEqual([]);
  });
});
