/**
 * Lets `src/` run straight from TypeScript — `npm run dev`, and the integration
 * test harness.
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
 * built, this runs against exactly what `npm run build` produced; before that it
 * still runs.
 *
 * Registering happens as an import side effect, so it has to be loaded before
 * anything it should affect — `node --import ./src/dev-resolve.ts src/index.ts`
 * for the dev server, the first import in the test harness for the suite.
 *
 * Development and test only. Nothing that ships imports this: the image runs
 * `dist/`, where every one of those specifiers resolves on its own.
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
