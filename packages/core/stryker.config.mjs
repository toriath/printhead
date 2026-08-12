import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Mutation gate for the simulation's decision-making code (spec §13): the
 * content interpreters in `systems/`, the curve library and the `VisualState`
 * projection must score >= 80 %.
 *
 * The plugin is resolved to an absolute path on purpose: pnpm's isolated
 * `node_modules` hides sibling packages from Stryker's own directory, so the
 * default `@stryker-mutator/*` glob finds nothing.
 */
const require = createRequire(import.meta.url);
const vitestRunner = join(
  dirname(require.resolve('@stryker-mutator/vitest-runner/package.json')),
  'dist/src/index.js',
);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: [vitestRunner],
  vitest: { configFile: 'vitest.config.ts' },
  mutate: [
    'src/systems/**/*.ts',
    'src/curves/**/*.ts',
    // M2 adds the projection: it is the contract every renderer reads, so it
    // is held to the same bar as the interpreters that feed it.
    'src/visual/**/*.ts',
    '!**/*.test.ts',
    '!**/__fixtures__/**',
    /**
     * `visual/fixtures.ts` is excluded deliberately, and not because it is
     * hard to test — its one behaviour (throw when a frozen fixture has
     * drifted) is asserted directly in `visual-state.test.ts`.
     *
     * Its whole body runs at *import* time, and Stryker's vitest runner
     * records import-time execution as static coverage, which it then reports
     * as "no coverage". Including it does not merely score itself at 0 %: it
     * corrupts per-test attribution for its neighbours too. Measured on this
     * tree, `visual/` scores 92.9 % without it and 33.6 % with it, while
     * `visual-state.ts` alone is 91.7 % either way. Excluding it is the
     * difference between a gate that measures something and one that does not.
     */
    '!src/visual/fixtures.ts',
  ],
  ignorePatterns: ['**/node_modules/**', '**/dist/**', 'reports/**'],
  concurrency: 2,
  coverageAnalysis: 'perTest',
  timeoutMS: 20000,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 95, low: 85, break: 80 },
};
