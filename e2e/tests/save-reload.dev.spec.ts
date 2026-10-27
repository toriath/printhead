import { expect, test } from '@playwright/test';
import {
  T0,
  assemblePrinter,
  bootGame,
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

    // The restored state must be identical, field for field.
    await bootGame(page, { nowMs: T0, paused: true });
    await pause(page);
    expect(await snapshot(page)).toEqual(before);
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

test.describe('time away (spec §7.4: no offline progress)', () => {
  test('a two-hour absence changes nothing', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await page.getByTestId('configure').click();
    await page.getByTestId('print').click();
    await saveNow(page);
    const before = await snapshot(page);
    const savedAt = await nowMs(page);

    // The clock says two hours have passed since the save. The workshop only
    // runs while the game is open, so the save resumes exactly as it was.
    await bootGame(page, { nowMs: savedAt + 2 * MS_PER_HOUR, paused: true });
    await pause(page);
    expect(await snapshot(page)).toEqual(before);
  });
});
