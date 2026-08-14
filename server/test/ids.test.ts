import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUuid } from '../src/ids.ts';

/**
 * The predicate that decides whether a client-supplied id is worth handing to
 * Postgres. Pure and dependency-free on purpose, so it is covered by a plain
 * `npm test` even where no database is available.
 */
describe('isUuid', () => {
  it('accepts an id in the shape we hand out', () => {
    assert.equal(isUuid('2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11'), true);
  });

  it('accepts it in upper case — Postgres does not care, and nor should we', () => {
    assert.equal(isUuid('2F1C4BB4-3F1F-4A4C-9A1E-2B7D5C8F0A11'), true);
    assert.equal(isUuid('2f1c4bb4-3F1F-4a4c-9A1E-2b7d5c8f0a11'), true);
  });

  it('accepts the nil uuid, and versions we do not issue', () => {
    // The check is "could this be a row we stored", not "is this RFC 9562 v4".
    // Rejecting an id the uuid column happily holds would turn a real row into
    // a 404, which is a worse bug than the one being fixed.
    assert.equal(isUuid('00000000-0000-0000-0000-000000000000'), true);
    assert.equal(isUuid('2f1c4bb4-3f1f-9a4c-9a1e-2b7d5c8f0a11'), true, 'version nibble 9');
    assert.equal(isUuid('2f1c4bb4-3f1f-1a4c-fa1e-2b7d5c8f0a11'), true, 'reserved variant');
  });

  it('rejects the things that used to reach Postgres and blow up', () => {
    for (const value of ['not-a-uuid', '1', 'nope', '', 'undefined', 'null']) {
      assert.equal(isUuid(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });

  it('rejects forms Postgres would take but we never emit', () => {
    // Narrower than the uuid input parser deliberately: every id we put in a URL
    // is canonical, so anything else is someone poking at the API.
    assert.equal(isUuid('2f1c4bb43f1f4a4c9a1e2b7d5c8f0a11'), false, 'no hyphens');
    assert.equal(isUuid('{2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11}'), false, 'braced');
    assert.equal(isUuid('urn:uuid:2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11'), false, 'urn');
  });

  it('is anchored at both ends', () => {
    const id = '2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11';
    for (const value of [` ${id}`, `${id} `, `${id}\n`, `\n${id}`, `${id}x`, `x${id}`, `${id}${id}`]) {
      assert.equal(isUuid(value), false, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });

  it('rejects an id with something smuggled onto the end of it', () => {
    const id = '2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11';
    assert.equal(isUuid(`${id}'; DROP TABLE tasks; --`), false);
    assert.equal(isUuid(`${id}\n2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a12`), false);
  });

  it('rejects the wrong number of digits in a group', () => {
    assert.equal(isUuid('2f1c4bb-3f1f-4a4c-9a1e-2b7d5c8f0a11'), false);
    assert.equal(isUuid('2f1c4bb44-3f1f-4a4c-9a1e-2b7d5c8f0a11'), false);
    assert.equal(isUuid('2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a1'), false);
    assert.equal(isUuid('2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a111'), false);
  });

  it('rejects non-hex characters', () => {
    assert.equal(isUuid('2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0ag1'), false);
    assert.equal(isUuid('gggggggg-gggg-gggg-gggg-gggggggggggg'), false);
  });
});
