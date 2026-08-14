import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListDetail, ListSummary, Me } from '@tally/shared';
import { fakeServer, settle, signIn, signOut, type FakeServer } from '../test/harness';
import { DataProvider, useData } from './store';

/* The provider asks Firebase who is signed in and holds a live stream open.
   Neither survives a test run, and neither is what is under test here: what is
   under test is the cache wiring between them. */
vi.mock('./auth', async () => {
  const { useFakeAuth } = await import('../test/harness');
  return { useAuth: useFakeAuth };
});
vi.mock('./stream', () => ({ connectStream: () => () => undefined }));

const alex: Me = { id: 'alex', displayName: 'Alex', email: 'alex@example.com', photoUrl: null };
const sam: Me = { id: 'sam', displayName: 'Sam', email: null, photoUrl: null };

const ALEX_UID = 'firebase-alex';
const SAM_UID = 'firebase-sam';

function list(id: string, name: string): ListSummary {
  return {
    id,
    name,
    emoji: '🏠',
    color: 'blurple',
    ownerId: 'alex',
    createdAt: '2026-08-01T00:00:00.000Z',
    cadence: 'daily',
    cadenceIntervalDays: 3,
    weekStart: 1,
    timezone: 'Europe/London',
    resetHour: 4,
    role: 'owner',
    taskCount: 0,
    doneCount: 0,
    periodKey: 'd:2026-08-13',
    // Far enough ahead that nothing restored has expired out from under a test.
    resetsAt: '2099-01-01T00:00:00.000Z',
    members: [],
  };
}

/** An hour ago, so a copy can be told apart from a fresh fetch by its timestamp. */
const SAVED_AT = Date.parse('2026-08-13T07:00:00.000Z');

/** What a previous session would have left on the device. */
function seedCache(uid: string, me: Me, lists: ListSummary[]): void {
  const details: Record<string, ListDetail> = {};
  window.localStorage.setItem(
    'tally.cache',
    JSON.stringify({ version: 1, uid, me, savedAt: SAVED_AT, lists, details }),
  );
}

function storedCache(): { uid: string; savedAt: number; lists: ListSummary[] } | null {
  const raw = window.localStorage.getItem('tally.cache');
  return raw ? (JSON.parse(raw) as { uid: string; savedAt: number; lists: ListSummary[] }) : null;
}

/** Renders the bits of the store's contract these tests make claims about. */
function Probe() {
  const { lists, listsLoading, savedAt } = useData();
  return (
    <div>
      <p data-testid="status">{listsLoading ? 'loading' : 'ready'}</p>
      <p data-testid="saved">{savedAt === null ? 'never' : String(savedAt)}</p>
      <ul data-testid="lists">
        {lists.map((item) => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  );
}

const names = () => [...screen.getByTestId('lists').children].map((item) => item.textContent);

const mount = () =>
  render(
    <DataProvider>
      <Probe />
    </DataProvider>,
  );

let server: FakeServer;

beforeEach(() => {
  window.localStorage.clear();
  server = fakeServer();
});

afterEach(() => {
  server.restore();
  signOut();
});

describe('DataProvider and the saved copy', () => {
  it('puts the saved lists on screen before the request for them comes back', async () => {
    // The lift-and-basement case: something to look at while /api/lists hangs.
    seedCache(ALEX_UID, alex, [list('home', 'Home'), list('flat', 'Flat admin')]);
    server.hold('/lists');
    signIn(ALEX_UID, alex);

    mount();

    expect(names()).toEqual(['Home', 'Flat admin']);
    expect(screen.getByTestId('status').textContent).toBe('ready');
    // ...and it did not settle for the copy: the request went out anyway.
    await waitFor(() => expect(server.asked).toContain('/api/lists'));
  });

  it('replaces the saved copy with what the server says when it lands', async () => {
    seedCache(ALEX_UID, alex, [list('home', 'Home')]);
    const respond = server.hold('/lists');
    signIn(ALEX_UID, alex);

    mount();
    expect(names()).toEqual(['Home']);

    respond([list('home', 'Home'), list('bins', 'Bins')]);

    await waitFor(() => expect(names()).toEqual(['Home', 'Bins']));
  });

  it('shows nothing rather than a stranger’s lists when the copy is someone else’s', async () => {
    // A shared tablet. Sam signs in; Alex's saved copy must not be offered up.
    seedCache(ALEX_UID, alex, [list('home', 'Home')]);
    server.hold('/lists');
    signIn(SAM_UID, sam);

    mount();

    expect(names()).toEqual([]);
    await waitFor(() => expect(server.asked).toContain('/api/lists'));
  });

  it('saves what the server sent, so the next launch has it', async () => {
    server.answer('/lists', [list('home', 'Home')]);
    signIn(ALEX_UID, alex);

    mount();

    await waitFor(() => expect(storedCache()?.lists.map((item) => item.name)).toEqual(['Home']));
    expect(storedCache()?.uid).toBe(ALEX_UID);
  });

  it('keeps the copy, and the moment it was true, when the request never lands', async () => {
    // Offline for the whole session. The failure must not empty the screen, and
    // the age shown has to stay the age of the data — not the age of the attempt.
    seedCache(ALEX_UID, alex, [list('home', 'Home')]);
    signIn(ALEX_UID, alex);

    mount();
    await settle();

    expect(names()).toEqual(['Home']);
    expect(screen.getByTestId('saved').textContent).toBe(String(SAVED_AT));
    expect(storedCache()?.savedAt).toBe(SAVED_AT);
  });
});

describe('DataProvider on sign-out', () => {
  it('leaves nothing on the screen or on the device', async () => {
    server.answer('/lists', [list('home', 'Home')]);
    signIn(ALEX_UID, alex);

    mount();
    await waitFor(() => expect(names()).toEqual(['Home']));
    expect(storedCache()).not.toBeNull();

    signOut();

    expect(names()).toEqual([]);
    expect(window.localStorage.getItem('tally.cache')).toBeNull();
    expect(screen.getByTestId('saved').textContent).toBe('never');
  });

  it('does not hand one account’s lists to the next account to sign in', async () => {
    // The wipe and the save are scheduled in the same commit, so a save guarded
    // on the signed-in uid alone would write Alex's lists under Sam's key.
    server.answer('/lists', [list('home', 'Home')]);
    signIn(ALEX_UID, alex);

    mount();
    await waitFor(() => expect(storedCache()?.uid).toBe(ALEX_UID));

    // Sam's own load never lands, so whatever is on screen or on disk after the
    // switch could only have come from Alex's session.
    server.hold('/lists');
    signIn(SAM_UID, sam);

    expect(names()).toEqual([]);
    expect(storedCache()).toBeNull();
    await settle();
    expect(storedCache()).toBeNull();
  });
});
