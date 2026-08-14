import { z } from 'zod';

/**
 * Is this string shaped like an id we could have issued?
 *
 * Every id in this API is a Postgres `uuid`, and handing that column something
 * it can't parse raises a 22P02 that surfaces as a 500 — the wrong answer twice
 * over: nothing went wrong on our side, and a caller who supplies an id we
 * can't even read should learn no more than one who guesses a real id belonging
 * to someone else. So the shape is checked before the value reaches SQL.
 *
 * `z.guid()` rather than `z.uuid()` on purpose. `z.uuid()` enforces the RFC 9562
 * version and variant nibbles; the `uuid` column does not, so a row that is
 * perfectly retrievable by hand could be rejected here and turn into a 404.
 * The guard must only ever reject what the database would have rejected anyway.
 *
 * It is narrower than Postgres's own parser in the other direction: the braced
 * and hyphen-free forms `uuid_in` also accepts are refused, because every id we
 * put in a URL is canonical and anything else is someone poking at the API.
 */
const uuidSchema = z.guid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}
