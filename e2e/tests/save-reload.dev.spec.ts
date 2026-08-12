import { expect, test } from '@playwright/test';
import {
  T0,
  assemblePrinter,
  bootGame,
  content,
  nowMs,
  pause,
  saveNow,
  snapshot,
  waitForHooks,
  warp,
} from './harness.js';

const MS_PER_SECOND = 1000;
const MS_PER_HOUR = 3_600_000;

test.describe('saves', () => {
  // These share one IndexedDB per browser context, so they must not run in
  // parallel against each other inside a worker.
  test('a reload restores exactly the state that was saved', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await page.getByTestId('configure').click();
    await page.getByTestId('print').click();
    await warp(page, 30 * MS_PER_SECOND);
    await saveNow(page);

    const before = await snapshot(page);
    expect(before).toMatchObject({ phaseId: 'intro' });

    // Come back at exactly the moment we left: nothing to catch up on, so the
    // restored state must be identical, field for field.
    await bootGame(page, { nowMs: T0, paused: true });
    await pause(page);
    expect(await snapshot(page)).toEqual(before);
    await expect(page.getByTestId('offline-summary')).toHaveCount(0);
  });

  test('a save written by this build survives a hard reload of the tab', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await saveNow(page);
    const before = await snapshot(page);

    await page.reload();
    await waitForHooks(page);
    await pause(page);
    expect(await snapshot(page)).toEqual(before);
  });
});

test.describe('offline progress (spec §7.4)', () => {
  test('a two-hour absence is replayed and summarised on return', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await page.getByTestId('configure').click();
    await page.getByTestId('print').click();
    await saveNow(page);
    const savedAt = await nowMs(page);

    // The platform seam is the only thing that changes: the clock says two
    // hours have passed since the save. Everything else — the reducer, the
    // pace, the cap — is the code the live game runs.
    await bootGame(page, { nowMs: savedAt + 2 * MS_PER_HOUR, paused: true });

    await expect(page.getByTestId('offline-summary')).toBeVisible();
    await expect(page.getByTestId('offline-away')).toContainText('2 h');
    await expect(page.getByTestId('offline-prints')).not.toHaveText('0');
    await expect(page.getByTestId('offline-capped')).toHaveCount(0);

    await page.getByTestId('offline-dismiss').click();
    await expect(page.getByTestId('offline-summary')).toHaveCount(0);
  });

  test('says so when the cap swallowed part of the absence', async ({ page }) => {
    await bootGame(page);
    await saveNow(page);
    const savedAt = await nowMs(page);
    const capHours = (await content(page)).pacing.offlineCapHours;

    await bootGame(page, { nowMs: savedAt + (capHours + 6) * MS_PER_HOUR, paused: true });
    await expect(page.getByTestId('offline-capped')).toContainText('6 h');
  });
});
