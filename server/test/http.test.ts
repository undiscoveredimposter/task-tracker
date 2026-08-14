// Registers the hooks that let `../src/*.ts` resolve its `./x.js` specifiers.
import './helpers/ts-resolve.ts';

import assert from 'node:assert/strict';
import type { Request } from 'express';
import { describe, it } from 'node:test';

// `config.ts` is read once at import and insists on a DATABASE_URL. Nothing
// under test here opens a connection — `http.ts` reaches `config` only through
// `errors.ts`, which wants `isProduction` — so a placeholder is enough to load
// the module without a database anywhere near it.
process.env.DATABASE_URL ||= 'postgresql://placeholder/unused';

const { param, uuidParam } = await import('../src/http.ts');
const { HttpError, notFound } = await import('../src/errors.ts');

const request = (params: Record<string, string | string[] | undefined>) =>
  ({ params }) as unknown as Request;

const ID = '2f1c4bb4-3f1f-4a4c-9a1e-2b7d5c8f0a11';

describe('param', () => {
  it('reads a route parameter', () => {
    assert.equal(param(request({ id: ID }), 'id'), ID);
  });

  it('takes the first when mergeParams has produced an array', () => {
    assert.equal(param(request({ id: [ID, 'other'] }), 'id'), ID);
  });

  it('is a 400 when the parameter is not there at all — that is a mounting bug', () => {
    assert.throws(() => param(request({}), 'id'), (error: HttpError) => error.status === 400);
  });
});

describe('uuidParam', () => {
  it('passes a well-formed id straight through', () => {
    assert.equal(uuidParam(request({ id: ID }), 'id'), ID);
    assert.equal(uuidParam(request({ id: ID.toUpperCase() }), 'id'), ID.toUpperCase());
  });

  it('is a 404 for anything that is not an id, not a 500 from Postgres', () => {
    for (const value of ['not-a-uuid', '1', 'nope', `${ID}x`, `${ID}\n`]) {
      assert.throws(
        () => uuidParam(request({ id: value }), 'id'),
        (error: HttpError) => error instanceof HttpError && error.status === 404,
        `expected ${JSON.stringify(value)} to be a 404`,
      );
    }
  });

  it('says exactly what a genuinely missing row says', () => {
    // The point of the 404: a caller must not be able to tell "we could not
    // parse that" from "there is no such list" from "that list is not yours".
    let thrown: HttpError | undefined;
    try {
      uuidParam(request({ id: 'not-a-uuid' }), 'id', 'That list');
    } catch (error) {
      thrown = error as HttpError;
    }
    assert.ok(thrown);
    assert.equal(thrown.status, notFound('That list').status);
    assert.equal(thrown.message, notFound('That list').message);
    assert.equal(thrown.code, notFound('That list').code);
  });

  it('never echoes the offending value back', () => {
    const nasty = "<script>alert(1)</script>'; DROP TABLE tasks; --";
    try {
      uuidParam(request({ id: nasty }), 'id', 'That task');
      assert.fail('expected a throw');
    } catch (error) {
      assert.doesNotMatch((error as HttpError).message, /script|DROP/i);
    }
  });

  it('checks the parameter named, not whichever one is handy', () => {
    const req = request({ id: ID, userId: 'not-a-uuid' });
    assert.equal(uuidParam(req, 'id'), ID);
    assert.throws(() => uuidParam(req, 'userId'), (error: HttpError) => error.status === 404);
  });
});
