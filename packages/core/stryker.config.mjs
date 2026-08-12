import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Mutation gate for the simulation's decision-making code (spec §13): the
 * content interpreters in `systems/` and the curve library must score >= 80 %.
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
  mutate: ['src/systems/**/*.ts', 'src/curves/**/*.ts', '!**/*.test.ts'],
  ignorePatterns: ['**/node_modules/**', '**/dist/**', 'reports/**'],
  concurrency: 2,
  coverageAnalysis: 'perTest',
  timeoutMS: 20000,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 95, low: 85, break: 80 },
};
