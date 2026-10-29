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
  // The intro is the bench alone: no header, no workshop yet.
  await expect(page.getByTestId('phase')).toHaveText('intro');
  await expect(page.getByTestId('assembly-bench')).toBeVisible();
  await expect(page.getByTestId('attach')).toBeVisible();
  // Not the finished game, and it says so on the first screen.
  await expect(page.getByTestId('release-banner')).toContainText('Beta');
});

test('the dev test seam is stripped from the production bundle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('attach')).toBeVisible();
  expect(await page.evaluate(() => '__PRINTHEAD__' in window)).toBe(false);
});

/**
 * Spec §14: the editor is "excluded from production bundles via build flag
 * (`import.meta.env.DEV` + separate chunk)". The panel is loaded from a dynamic
 * import inside a DEV branch, so a production build eliminates the branch and
 * never emits the chunk — this checks the artefact, not the intention.
 */
test('the dev editor panel is not in the production bundle', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('attach')).toBeVisible();
  await expect(page.getByTestId('editor-open')).toHaveCount(0);
  await expect(page.getByTestId('editor')).toHaveCount(0);

  // Nothing the browser fetched may contain the panel's markers.
  const scripts = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll('script[src]'),
      (script) => script.getAttribute('src') ?? '',
    ),
  );
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    const body = await (await page.request.get(src)).text();
    expect(body, src).not.toContain('ph-editor__scroll');
    expect(body, src).not.toContain('__printhead/content/');
  }
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
