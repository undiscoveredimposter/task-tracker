import { defineConfig } from 'vitest/config';

/**
 * Two projects, split by file extension.
 *
 * `.test.ts` is the node project: no DOM, nothing to set up, and fast. Pure
 * logic keeps being extracted so it can be tested there.
 *
 * `.test.tsx` is the jsdom project, and exists only for what a pure function
 * cannot be asked about — the order a provider's effects fire in and what they
 * leave behind. Reaching for it should mean the logic genuinely lives in the
 * wiring, not that extracting it was inconvenient.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
});
