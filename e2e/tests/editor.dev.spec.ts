import { expect, test } from '@playwright/test';
import { bootGame, warp } from './harness.js';

/**
 * The dev Editor panel (spec §14), smoke-tested in a real dev build — which is
 * the only place it exists. Everything here goes through the panel's own
 * controls, not through the test seam, because what is under test is the panel.
 */
test('the editor opens and reports the running game', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('editor-phase')).toContainText('intro');
  await expect(page.getByTestId('editor-state')).toContainText('parts 0');
});

test('the content inspector is generated from the schemas', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();

  // Every content file is offered, including ones nobody wrote editor code for.
  const files = await page.getByTestId('editor-file').locator('option').allTextContents();
  expect(files).toContain('failure');
  expect(files).toContain('prestige');

  // ...and a file's fields come from its zod schema, not from a hand-written form.
  await page.getByTestId('editor-file').selectOption('materials');
  // Scoped to the inspector: the state tree below it also mentions "pla",
  // because a workshop's filament ledger is keyed by material.
  await page.getByTestId('editor-groups').getByText('pla', { exact: true }).click();
  await expect(page.getByTestId('field-0.costPerGram')).toBeVisible();
  await expect(page.getByTestId('field-0.supply')).toBeVisible();
});

test('an edit hot-applies to the running simulation', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();
  await page.getByTestId('field-targetHours').fill('4');
  await expect(page.getByTestId('editor-status')).toHaveText('applied');

  const targetHours = await page.evaluate(
    () => window.__PRINTHEAD__?.game.store.getContent().pacing.targetHours,
  );
  expect(targetHours).toBe(4);
});

test('invalid content is rejected and the game keeps the last good set', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();
  await page.getByTestId('field-targetHours').fill('0');
  await expect(page.getByTestId('editor-status')).toContainText('rejected');

  const targetHours = await page.evaluate(
    () => window.__PRINTHEAD__?.game.store.getContent().pacing.targetHours,
  );
  expect(targetHours).toBe(8);
});

test('the write-back endpoint validates before it touches disk', async ({ page, request }) => {
  await bootGame(page, { paused: true });
  // Posted directly rather than through the panel: a passing test must not
  // rewrite the repository's content files.
  const rejected = await request.post('/__printhead/content/pacing', {
    data: { targetHours: -1 },
  });
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).message).toContain('rejected');

  const unknown = await request.post('/__printhead/content/not-a-file', { data: {} });
  expect(unknown.status()).toBe(404);
});

test('time controls warp on top of pace without changing the rules', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();

  const simTime = async (): Promise<number> =>
    ((await page.evaluate(() => window.__PRINTHEAD__?.snapshot())) as { simTimeMs: number })
      .simTimeMs;

  await warp(page, 1000);
  const normal = await simTime();
  expect(normal).toBeGreaterThan(0);

  await page.getByTestId('editor-warp-100').click();
  await expect(page.getByTestId('editor-warp-100')).toHaveAttribute('aria-pressed', 'true');
  await warp(page, 1000);
  expect((await simTime()) - normal).toBeGreaterThan(normal * 50);
});

test('jump-to-phase drops the FSM straight into late content', async ({ page }) => {
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();
  await page.getByTestId('editor-jump').selectOption('studio');
  await expect(page.getByTestId('phase')).toHaveText('studio');
  await expect(page.getByTestId('editor-phase')).toContainText('studio');
});

test('pause and resume drive the real loop', async ({ page }) => {
  // The E2E harness boots paused so the test owns the clock, so the panel
  // correctly opens offering "Resume".
  await bootGame(page, { paused: true });
  await page.getByTestId('editor-open').click();
  await expect(page.getByTestId('editor-pause')).toHaveText('Resume');
  await page.getByTestId('editor-pause').click();
  await expect(page.getByTestId('editor-pause')).toHaveText('Pause');
  await page.getByTestId('editor-pause').click();
  await expect(page.getByTestId('editor-pause')).toHaveText('Resume');
});
