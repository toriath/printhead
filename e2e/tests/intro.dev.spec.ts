import { expect, test } from '@playwright/test';
import { assemblePrinter, bootGame, content, warp } from './harness.js';

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
    const workshop = page.getByRole('img');
    await expect(workshop.locator('[data-part="frame"]')).toHaveCount(1);
    await expect(workshop.locator('[data-part="controller"]')).toHaveCount(1);

    await page.getByTestId('configure').click();
    await page.getByTestId('print').click();
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

  test('draws the whole slot rack, empty bays included (spec §4)', async ({ page }) => {
    await bootGame(page);
    const capacity = await page.getByRole('img').getAttribute('data-slot-capacity');
    await expect(page.locator('[data-testid^="bay-"]')).toHaveCount(Number(capacity));
  });
});
