import { z } from 'zod';

/**
 * What a display name is allowed to be, and what to call somebody when the
 * identity provider gave us nothing to work with.
 *
 * Kept out of the route so both halves can be tested directly: this is the
 * whole of the decision-making behind `GET/PATCH /api/me`, and none of it needs
 * a database.
 */

/** Long enough for "Alexandra Featherstonehaugh", short enough for an avatar. */
export const DISPLAY_NAME_MAX = 32;

/**
 * Control characters, including the line breaks that would let a name break the
 * layout of a members list. Rendered as text everywhere, so this is tidiness
 * rather than safety — but a name is not a paragraph.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A sensible display name when the identity provider gives us nothing better.
 * Used on the auth upsert, so every user row has something to show from the
 * first request rather than an empty avatar.
 */
export function providerDisplayName(name: string | null, email: string | null): string {
  if (name && name.trim()) return name.trim();
  const local = email?.split('@')[0]?.trim();
  if (local) return local;
  return 'Someone';
}

/**
 * The body of `PATCH /api/me`.
 *
 * `.trim()` runs before the length checks, so a name padded out to the cap with
 * spaces is accepted at its real length and stored without them — and one that
 * is nothing but spaces is rejected rather than stored as an invisible name.
 */
export const updateMeSchema = z.object({
  displayName: z
    .string('Your name needs to be some text')
    .trim()
    .min(1, 'Your name cannot be empty')
    .max(DISPLAY_NAME_MAX, `Names are limited to ${DISPLAY_NAME_MAX} characters`)
    .refine((name) => !CONTROL_CHARACTERS.test(name), 'A name cannot contain line breaks'),
});
