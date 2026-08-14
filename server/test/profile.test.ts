import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISPLAY_NAME_MAX, providerDisplayName, updateMeSchema } from '../src/profile.ts';

/**
 * The two decisions behind a profile, pulled out of the route so they can be
 * tested without a database: what to call someone the provider barely described,
 * and what counts as a name they are allowed to choose for themselves.
 */

describe('providerDisplayName', () => {
  it('prefers the name the provider sent', () => {
    assert.equal(providerDisplayName('Alex Rivera', 'alex@example.test'), 'Alex Rivera');
  });

  it('trims it', () => {
    assert.equal(providerDisplayName('  Alex  ', 'alex@example.test'), 'Alex');
  });

  it('falls back to the local part of the email', () => {
    assert.equal(providerDisplayName(null, 'alex@example.test'), 'alex');
  });

  it('treats a blank provider name as no name at all', () => {
    assert.equal(providerDisplayName('   ', 'alex@example.test'), 'alex');
  });

  it('has something to say even with neither', () => {
    assert.equal(providerDisplayName(null, null), 'Someone');
  });

  it('does not hand back an empty string for an email with no local part', () => {
    assert.equal(providerDisplayName(null, '@example.test'), 'Someone');
  });
});

describe('updateMeSchema', () => {
  const parse = (body: unknown) => updateMeSchema.safeParse(body);

  it('accepts a short name', () => {
    const result = parse({ displayName: 'Alex' });
    assert.equal(result.success, true);
    assert.equal(result.data?.displayName, 'Alex');
  });

  it('trims before it does anything else', () => {
    const result = parse({ displayName: '  Alex  ' });
    assert.equal(result.success, true);
    assert.equal(result.data?.displayName, 'Alex');
  });

  it('rejects a name that is empty once trimmed', () => {
    const result = parse({ displayName: '   ' });
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0]!.message, /name/i);
  });

  it('rejects an empty string', () => {
    assert.equal(parse({ displayName: '' }).success, false);
  });

  it(`accepts exactly ${DISPLAY_NAME_MAX} characters`, () => {
    assert.equal(parse({ displayName: 'a'.repeat(DISPLAY_NAME_MAX) }).success, true);
  });

  it('rejects one character more', () => {
    const result = parse({ displayName: 'a'.repeat(DISPLAY_NAME_MAX + 1) });
    assert.equal(result.success, false);
    assert.match(result.error!.issues[0]!.message, new RegExp(String(DISPLAY_NAME_MAX)));
  });

  it('counts the trimmed length, so trailing spaces cannot push it over', () => {
    const padded = `${'a'.repeat(DISPLAY_NAME_MAX)}      `;
    assert.equal(parse({ displayName: padded }).success, true);
  });

  it('rejects line breaks and other control characters', () => {
    assert.equal(parse({ displayName: 'Alex\nRivera' }).success, false);
    assert.equal(parse({ displayName: 'Alex\tRivera' }).success, false);
    assert.equal(parse({ displayName: 'Alex\u0007Rivera' }).success, false);
    assert.equal(parse({ displayName: 'Alex\u0085Rivera' }).success, false);
  });

  it('leaves emoji and accents alone', () => {
    const result = parse({ displayName: 'Álex 🐈' });
    assert.equal(result.success, true);
    assert.equal(result.data?.displayName, 'Álex 🐈');
  });

  it('rejects a missing name', () => {
    assert.equal(parse({}).success, false);
  });

  it('rejects a name that is not a string', () => {
    assert.equal(parse({ displayName: 42 }).success, false);
    assert.equal(parse({ displayName: null }).success, false);
    assert.equal(parse({ displayName: { toString: 'Alex' } }).success, false);
  });

  it('rejects a body that is not an object at all', () => {
    assert.equal(parse(undefined).success, false);
    assert.equal(parse('Alex').success, false);
  });

  it('gives back only the name, so nothing else on the body can be smuggled through', () => {
    const result = parse({ displayName: 'Alex', id: 'someone-else', role: 'owner' });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { displayName: 'Alex' });
  });
});
