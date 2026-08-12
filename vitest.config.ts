import { defineConfig } from 'vitest/config';

// Root aggregator: every workspace package brings its own vitest.config.ts.
// e2e/ is deliberately excluded — Playwright owns it (spec §13).
export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*'],
  },
});
