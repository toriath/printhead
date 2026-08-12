import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs chromium inside the devcontainer (spec §13). The app is a
 * stub until M2, so E2E is not part of `pnpm check` yet; it is wired now so the
 * intro / save-reload / offline / prestige suites have a home.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4173' },
  webServer: {
    command: 'pnpm --filter @printhead/app preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
