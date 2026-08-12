import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The offline-equivalence properties replay hours of simulation at a
    // 100 ms timestep. That is comfortably fast normally, but Stryker runs the
    // suite under instrumentation, where the default 5 s budget is not enough
    // and every mutant would be scored against a spurious timeout.
    testTimeout: 60_000,
    /**
     * Spec §13: `core` unit coverage ≥ 90 % line/branch, CI-gated (§17).
     * Barrel `index.ts` files are re-export lists with nothing to execute, and
     * `__fixtures__` are data; counting either would only dilute the signal.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/__fixtures__/**', 'src/**/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
