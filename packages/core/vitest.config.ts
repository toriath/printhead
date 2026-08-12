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
  },
});
