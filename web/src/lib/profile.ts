import type { ListSummary } from '@tally/shared';

/**
 * The decisions the account screen makes before it touches the network.
 *
 * The server is the authority on all of it — server/src/profile.ts trims,
 * measures and refuses. What is here only exists so the Save button can be
 * honest about whether pressing it would do anything, and so the consequences
 * of deleting a profile are on screen in words rather than discovered after.
 */

/**
 * Matches `DISPLAY_NAME_MAX` on the server, which is not exported over the
 * wire. Used for the field's `maxLength`: a cap you can feel while typing beats
 * one that arrives as a 400.
 */
export const DISPLAY_NAME_MAX = 32;

export interface NameDraft {
  /** What would be sent — trimmed, the way the server will store it. */
  name: string;
  /** Whether saving would change anything the server does not already have. */
  savable: boolean;
}

export function draftName(typed: string, current: string): NameDraft {
  const name = typed.trim();
  return { name, savable: name.length > 0 && name !== current.trim() };
}

/**
 * The lists that go with the account, named.
 *
 * `DELETE /api/me` cascades through `lists.owner_id`, so deleting yourself
 * deletes the lists you own for the people you share them with. Naming them is
 * the difference between a warning that gets read and one that gets clicked
 * through — "Home is deleted for everyone on it" is a different sentence from
 * "this cannot be undone".
 */
export function ownedListsWarning(lists: readonly Pick<ListSummary, 'name' | 'role'>[]): string | null {
  const names = lists.filter((list) => list.role === 'owner').map((list) => list.name);
  if (names.length === 0) return null;

  if (names.length === 1) return `${names[0]} is deleted for everyone on it.`;

  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last} are deleted for everyone on them.`;
}
