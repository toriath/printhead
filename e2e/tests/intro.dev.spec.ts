import { expect, test } from '@playwright/test';
import { assemblePrinter, bootGame, content, warp, workshop } from './harness.js';

const MS_PER_SECOND = 1000;

test.describe('the intro (spec §6 phase 0)', () => {
  test('assembles printer #1 on the bench, then reveals the workshop', async ({ page }) => {
    await bootGame(page);
    await expect(page.getByTestId('phase')).toHaveText('intro');

    // The intro is the bench alone: no ledger, nothing built, nothing to wait for.
    await expect(page.getByTestId('assembly-bench')).toBeVisible();
    await expect(page.getByTestId('ledger')).toHaveCount(0);
    await expect(page.getByTestId('bench-printer').locator('[data-part]')).toHaveCount(0);
    await expect(page.getByTestId('attach')).toBeEnabled();

    await assemblePrinter(page);

    // Built: the bench and its attach button retire, and the workshop appears.
    await expect(page.getByTestId('attach')).toHaveCount(0);
    await expect(page.getByTestId('assembly-bench')).toHaveCount(0);
    await expect(page.getByTestId('parts')).toHaveText('0');
    const drawing = workshop(page);
    // (Printed Parts on the floor reuse the printer's own shapes, so "at least one".)
    await expect(drawing.locator('[data-part="frame"]')).not.toHaveCount(0);
    await expect(drawing.locator('[data-part="controller"]')).not.toHaveCount(0);

    // One click loads the bay and starts the print.
    await page.getByTestId('configure').click();
    await expect(page.getByTestId('print-status')).toContainText('printing Bracket');

    const printSeconds = (await content(page)).objects[0]?.printDesignSeconds ?? 0;
    await warp(page, printSeconds * MS_PER_SECOND);
    await expect(page.getByTestId('parts')).not.toHaveText('0');

    // Selling the first Part is the last intro gate; the FSM moves on a tick.
    await page.getByTestId('sell').click();
    await warp(page, MS_PER_SECOND);
    await expect(page.getByTestId('phase')).toHaveText('bench');
    await expect(page.getByTestId('phase-name')).toHaveText('Bench');
  });

  test('shows the machine tier the projection reports', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await expect(page.getByTestId('printer-figure')).toHaveAttribute('data-frame', 'acrylic');
    await expect(page.getByTestId('printer-figure')).toHaveAttribute('data-nozzle', 'brass');
  });

  test('stands the first printer alone on the workshop floor (spec §4)', async ({ page }) => {
    await bootGame(page);
    // The workshop is drawn once the printer wakes up; the intro is the bench alone.
    await assemblePrinter(page);
    // The floor draws the bays the workshop owns, not empty rack spaces.
    await expect(workshop(page)).toHaveAttribute('data-layout', 'floor');
    await expect(workshop(page).locator('[data-testid^="bay-slot-"]')).toHaveCount(1);
  });
});
