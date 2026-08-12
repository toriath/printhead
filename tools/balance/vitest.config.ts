import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'balance',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * A single balance assertion replays the whole 420-design-minute arc at a
     * 100 ms timestep — sometimes a dozen times, when the tuner is bisecting.
     * Vitest's 5 s default turns that into a flake rather than a measurement.
     */
    testTimeout: 120_000,
  },
});
