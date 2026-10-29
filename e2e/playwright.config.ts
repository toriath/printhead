import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright runs chromium, locally and in CI (spec §13).
 *
 * Two servers, two projects, on purpose:
 *
 * - **dev** (`vite`) hosts the gameplay suites. At `targetHours: 8` the intro
 *   takes five real minutes, so the tests drive a frozen clock through the dev
 *   test seam (`window.__PRINTHEAD__`, spec §14). Everything else is real: the
 *   real loop, the real reducer, the real pace mapping.
 * - **prod** (`vite build && vite preview`) smoke-tests the artefact that
 *   actually ships, and asserts the dev seam is *not* in it.
 */
const DEV_PORT = 4174;
const PREVIEW_PORT = 4173;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  workers: 2,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? 'list' : 'github',
  use: { ...devices['Desktop Chrome'] },
  projects: [
    {
      name: 'dev',
      testMatch: /.*\.dev\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${DEV_PORT}` },
    },
    {
      name: 'prod',
      testMatch: /.*\.prod\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @printhead/app exec vite --host 127.0.0.1 --port ${DEV_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEV_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @printhead/app build && pnpm --filter @printhead/app preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
