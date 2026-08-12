import { expect, test } from '@playwright/test';

/**
 * The production artefact — the bundle that actually ships (spec §17).
 *
 * The gameplay suites run against the dev server because they need the test
 * seam; this one exists to prove the shipped build boots on its own and that
 * the seam is *not* in it (spec §14: "excluded from production bundles").
 */
test('the shipped bundle boots into the intro', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PRINTHEAD' })).toBeVisible();
  await expect(page.getByTestId('phase')).toHaveText('intro');
  await expect(page.getByRole('img')).toBeVisible();
  await expect(page.getByTestId('attach')).toBeVisible();
});

test('the dev test seam is stripped from the production bundle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('attach')).toBeVisible();
  expect(await page.evaluate(() => '__PRINTHEAD__' in window)).toBe(false);
});

test('it ships an installable PWA manifest (spec §9)', async ({ page }) => {
  const response = await page.request.get('./manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest = (await response.json()) as {
    name: string;
    icons: { sizes: string }[];
    display: string;
  };
  expect(manifest.name).toBe('PRINTHEAD');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((icon) => icon.sizes)).toContain('512x512');
});

test('it registers a service worker so the game runs offline', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('attach')).toBeVisible();
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration !== undefined;
  });
  expect(registered).toBe(true);
});
