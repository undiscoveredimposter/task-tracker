import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWebRoot } from '../src/web-root.ts';

/**
 * The rule is small and the consequences of getting it wrong are not: a
 * relative WEB_ROOT used to serve assets and 500 every page navigation, because
 * express.static and res.sendFile disagree about what a relative path means.
 */
describe('resolveWebRoot', () => {
  const cwd = '/srv/app';

  describe('with static serving switched off', () => {
    it('leaves an empty value empty', () => {
      assert.equal(resolveWebRoot('', cwd), '');
    });

    it('treats an unset variable the same way', () => {
      assert.equal(resolveWebRoot(undefined, cwd), '');
    });

    it('treats whitespace as unset rather than as the working directory', () => {
      assert.equal(resolveWebRoot('   ', cwd), '');
      assert.equal(resolveWebRoot('\t\n', cwd), '');
    });
  });

  describe('with a relative path', () => {
    it('resolves it against the working directory', () => {
      assert.equal(resolveWebRoot('web/dist', cwd), '/srv/app/web/dist');
    });

    it('resolves an explicitly relative one', () => {
      assert.equal(resolveWebRoot('./web/dist', cwd), '/srv/app/web/dist');
    });

    it('resolves one that climbs out of the working directory', () => {
      assert.equal(resolveWebRoot('../build/web', cwd), '/srv/build/web');
    });

    it('resolves a bare dot to the working directory itself', () => {
      assert.equal(resolveWebRoot('.', cwd), '/srv/app');
    });
  });

  describe('with an absolute path', () => {
    it('returns it unchanged — production must not shift', () => {
      assert.equal(resolveWebRoot('/app/web/dist', cwd), '/app/web/dist');
    });

    it('ignores the working directory entirely', () => {
      assert.equal(
        resolveWebRoot('/app/web/dist', '/somewhere/else'),
        resolveWebRoot('/app/web/dist', cwd),
      );
    });
  });

  describe('tidying', () => {
    it('drops a trailing slash, so join() gives one path and not two', () => {
      assert.equal(resolveWebRoot('/app/web/dist/', cwd), '/app/web/dist');
      assert.equal(resolveWebRoot('web/dist/', cwd), '/srv/app/web/dist');
    });

    it('collapses redundant segments', () => {
      assert.equal(resolveWebRoot('/app/./web//dist', cwd), '/app/web/dist');
    });

    it('trims surrounding whitespace, which dashboards add and shells do not', () => {
      assert.equal(resolveWebRoot('  /app/web/dist  ', cwd), '/app/web/dist');
    });
  });

  it('defaults to the real working directory when none is given', () => {
    assert.equal(resolveWebRoot('web/dist'), `${process.cwd()}/web/dist`);
  });
});
