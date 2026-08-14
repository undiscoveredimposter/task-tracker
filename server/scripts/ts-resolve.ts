/**
 * Lets `npm run dev` and the integration tests load the server straight from
 * `src/`, with no build step in between.
 *
 * Node runs `.ts` files natively, but two specifiers in this repo don't resolve
 * at runtime on their own:
 *
 *   - `./auth.js` — the extension TypeScript's NodeNext module resolution
 *     requires us to write, which only exists after a build.
 *   - `@tally/shared` — whose package `exports` point at `dist/`, which likewise
 *     only exists after a build.
 *
 * Both get the same rule: try the real resolution first, and only if nothing is
 * there fall back to the TypeScript source. So once the workspace has been
 * built, tests run against exactly what `npm run build` produced; before that
 * they still run.
 *
 * Registering happens as an import side effect, so it has to come first: the
 * dev script loads it with `--import`, ahead of the entrypoint, and the test
 * harness imports it above everything else.
 *
 * It lives outside `src/` on purpose — it must not end up in `dist/`, where the
 * `.js` files it patches around already exist.
 */
import { registerHooks } from 'node:module';

const SHARED_SOURCE = new URL('../../shared/src/index.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier === '@tally/shared') {
        return { url: SHARED_SOURCE, shortCircuit: true };
      }
      if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
      }
      throw error;
    }
  },
});
