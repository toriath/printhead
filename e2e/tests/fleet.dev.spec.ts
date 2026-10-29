import { expect, test } from '@playwright/test';
import {
  assemblePrinter,
  bootGame,
  openTab,
  replaceState,
  snapshot,
  warp,
  workshop,
} from './harness.js';

const MS_PER_SECOND = 1000;

/**
 * Slots and the fleet (spec §4) in the browser.
 *
 * The intro is played for real; the farm phase is *placed* rather than ground
 * out, because eighty design-minutes of economy is not what this test is about.
 * From there every click goes through the shipped UI and the real reducer: the
 * bay appears because `BUY_SLOT` was accepted, and the machines move because
 * `ASSIGN_PRINTER` was.
 */
interface SlotShape {
  readonly id: string;
  readonly printerCount: number;
  readonly materialId: string | null;
}

interface StateShape {
  readonly phaseId: string;
  readonly slots: readonly SlotShape[];
  readonly resources: Record<string, number>;
  readonly printers: Record<string, number>;
  readonly forkId: string | null;
}

/** A staffed, full first bay in the phase where the rack goes on sale. */
const inTheFarm = (state: unknown): unknown => {
  const typed = state as StateShape;
  const first = typed.slots[0];
  return {
    ...typed,
    phaseId: 'farm',
    printers: { 'bench-mk1': 8 },
    resources: { ...typed.resources, parts: 5000, money: 500 },
    partsValue: 5000,
    filamentGrams: { pla: 4000 },
    slots: [{ ...first, materialId: 'pla', objectId: 'bracket', printerCount: 8 }],
  };
};

test.describe('the fleet (spec §4)', () => {
  test('buys a second config slot and spreads the machines across it', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, inTheFarm as never);
    await warp(page, MS_PER_SECOND);

    // One bay, full: the rack is now the thing holding the fleet back.
    await openTab(page, 'fleet');
    const fleet = page.getByTestId('fleet');
    await expect(fleet).toBeVisible();
    await expect(page.getByTestId('bay-status-slot-1')).toContainText('8/8');

    await page.getByTestId('buy-slot').click();
    await warp(page, MS_PER_SECOND);
    await expect(page.getByTestId('bay-status-slot-2')).toBeVisible();
    await expect(page.getByTestId('bay-status-slot-2')).toContainText('0/8');

    // The workshop still owns exactly the machines it owned a moment ago…
    await page.getByTestId('move-out-slot-1').click();
    await warp(page, MS_PER_SECOND);
    await expect(page.getByTestId('bay-status-slot-1')).toContainText('7/8');
    await expect(page.getByTestId('bay-status-slot-2')).toContainText('1/8');

    // …and the simulation agrees: assignment conserves the fleet.
    const after = (await snapshot(page)) as StateShape;
    const assigned = after.slots.reduce((total, slot) => total + slot.printerCount, 0);
    const owned = Object.values(after.printers).reduce((total, count) => total + count, 0);
    expect(assigned).toBe(owned);
    expect(after.slots).toHaveLength(2);
  });

  test('draws the new bay in the workshop, not just in the panel', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, inTheFarm as never);
    await warp(page, MS_PER_SECOND);

    const drawing = workshop(page);
    await expect(drawing).toHaveAttribute('data-layout', 'floor');
    await openTab(page, 'fleet');
    await page.getByTestId('buy-slot').click();
    await warp(page, MS_PER_SECOND);
    // The new bay stands on the workshop floor, next to the first.
    await expect(drawing.locator('[data-testid^="bay-slot-"]')).toHaveCount(2);
  });

  test('commits the run to one branch of the fork and closes the other', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    // Goliath needs a sintering head and one melt-down behind it (spec §5B).
    await replaceState(page, (state: unknown) => {
      const typed = inTheFarm(state) as StateShape & { stats: Record<string, number> };
      return {
        ...typed,
        phaseId: 'studio',
        upgrades: { 'sintering-head': 1 },
        resources: { ...typed.resources, money: 100_000 },
        stats: { ...typed.stats, prestigeCount: 1 },
      };
    });
    await warp(page, MS_PER_SECOND);

    await openTab(page, 'fleet');
    await expect(page.getByTestId('fork-farm-path')).toBeVisible();
    await expect(page.getByTestId('fork-goliath')).toBeVisible();

    await page.getByTestId('fork-goliath').click();
    await warp(page, MS_PER_SECOND);

    await expect(page.getByTestId('fork-chosen-goliath')).toBeVisible();
    await expect(page.getByTestId('fork-farm-path')).toHaveCount(0);
    // The rack is gone: one giant printer stands where it was (spec §5B).
    await expect(workshop(page)).toHaveAttribute('data-layout', 'goliath');
    expect(((await snapshot(page)) as StateShape).forkId).toBe('goliath');
  });
});
