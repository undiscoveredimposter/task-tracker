import { describe, expect, it } from 'vitest';
import type { ListSummary } from '@tally/shared';
import { draftName, ownedListsWarning } from './profile';

describe('draftName', () => {
  it('sends the trimmed name, not what was typed', () => {
    expect(draftName('  Alexandra  ', 'Alex')).toEqual({ name: 'Alexandra', savable: true });
  });

  it('will not save a name that is only whitespace', () => {
    // The field can be emptied, and the server would refuse it — say no here
    // rather than spending a round trip finding out.
    expect(draftName('   ', 'Alex').savable).toBe(false);
    expect(draftName('', 'Alex').savable).toBe(false);
  });

  it('will not save a name that has not changed', () => {
    expect(draftName('Alex', 'Alex').savable).toBe(false);
  });

  it('treats padding as no change, because the server would trim it away', () => {
    expect(draftName('  Alex  ', 'Alex').savable).toBe(false);
  });

  it('treats a change of case as a change', () => {
    // "alex" to "Alex" is the most likely reason anyone opens this screen.
    expect(draftName('alex', 'Alex')).toEqual({ name: 'alex', savable: true });
  });
});

const list = (name: string, role: ListSummary['role']) => ({ name, role }) as ListSummary;

describe('ownedListsWarning', () => {
  it('says nothing when you own none of the lists you are on', () => {
    // Nothing of anyone else's goes with the account, so there is nothing extra
    // to warn about.
    expect(ownedListsWarning([list('Home', 'editor'), list('Plants', 'viewer')])).toBeNull();
  });

  it('names the one list that goes with you', () => {
    expect(ownedListsWarning([list('Home', 'owner'), list('Plants', 'viewer')])).toBe(
      'Home is deleted for everyone on it.',
    );
  });

  it('joins two with "and"', () => {
    expect(ownedListsWarning([list('Home', 'owner'), list('Plants', 'owner')])).toBe(
      'Home and Plants are deleted for everyone on them.',
    );
  });

  it('joins three or more with commas and a final "and"', () => {
    expect(
      ownedListsWarning([
        list('Home', 'owner'),
        list('Flat admin', 'owner'),
        list('Plants', 'owner'),
      ]),
    ).toBe('Home, Flat admin and Plants are deleted for everyone on them.');
  });
});
