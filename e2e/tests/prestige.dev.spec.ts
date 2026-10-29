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
 * The full prestige cycle in a browser (spec §5D, §6 phase 4).
 *
 * The intro is played for real. The studio is *placed* rather than ground out —
 * a hundred and sixty design-minutes of economy is not what this test is about,
 * and `replaceState` is the same dev-only power the editor's save-import uses.
 * Everything after that is the shipped UI and the real reducer: the commission
 * is drafted because `CREATE_DESIGN` was accepted, the bay makes Products
 * because `SET_SLOT_DESIGN` was, and the workshop melts down because `PRESTIGE`
 * was.
 */
interface StateShape {
  readonly phaseId: string;
  readonly slots: readonly { readonly id: string; readonly designId: string | null }[];
  readonly resources: Record<string, number>;
  readonly designs: Record<string, { level: number; printsOnLevel: number }>;
  readonly moneyPrinters: Record<string, number>;
  readonly upgrades: Record<string, number>;
  readonly selfAssembling: boolean;
  readonly stats: Record<string, number>;
}

/** A studio-phase workshop: resin open, money banked, one staffed bay. */
const inTheStudio = (state: unknown): unknown => {
  const typed = state as StateShape;
  const first = typed.slots[0];
  return {
    ...typed,
    phaseId: 'studio',
    printers: { 'bench-mk1': 8 },
    upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1, 'design-desk': 2 },
    resources: { ...typed.resources, parts: 2000, money: 5_000_000 },
    partsValue: 2000,
    filamentGrams: { pla: 4000, resin: 8000 },
    slots: [{ ...first, materialId: 'pla', objectId: 'bracket', printerCount: 8 }],
  };
};

/** The same workshop, one phase on, with the capstone already in hand. */
const readyToMelt = (state: unknown): unknown => {
  const typed = inTheStudio(state) as StateShape;
  return {
    ...typed,
    phaseId: 'prestige',
    designs: { 'money-plate': { level: 4, printsOnLevel: 2 } },
    resources: { ...typed.resources, designs: 1 },
  };
};

test.describe('the Design Studio and the melt-down (spec §5D)', () => {
  test('drafts the capstone, prints Products from it and sells them', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, inTheStudio as never);
    await warp(page, MS_PER_SECOND);

    await openTab(page, 'studio');
    const studio = page.getByTestId('studio');
    await expect(studio).toBeVisible();

    // Draft the Money Plate. The bench takes real design time to do it.
    await page.getByTestId('draft-money-plate').click();
    await warp(page, MS_PER_SECOND);
    await expect(page.getByTestId('studio-drafting')).toContainText('Money plate');

    await warp(page, 30 * 60 * MS_PER_SECOND);
    await expect(page.getByTestId('studio-drafting')).toHaveCount(0);
    await expect(page.getByTestId('design-money-plate')).toContainText('lv 1');

    // Point the bay at it: from here the printers make Products, not Parts.
    // Switching to resin is a real changeover (spec §3), so the bay purges
    // before it will take a print.
    await page.getByTestId('load-money-plate-slot-1').click();
    await warp(page, 5 * 60 * MS_PER_SECOND);
    await page.getByTestId('print').click();
    await warp(page, 20 * 60 * MS_PER_SECOND);
    await expect(workshop(page).locator('[data-output="products"]')).not.toHaveCount(0);

    const printed = (await snapshot(page)) as StateShape;
    expect(printed.slots[0]?.designId).toBe('money-plate');
    expect(printed.stats.productsProduced).toBeGreaterThan(0);
    // Printing it levels it up (spec §5D).
    expect(printed.designs['money-plate']?.level ?? 0).toBeGreaterThan(1);

    await page.getByTestId('sell-products').click();
    await warp(page, MS_PER_SECOND);
    expect(((await snapshot(page)) as StateShape).stats.productsSold).toBeGreaterThan(0);
  });

  test('melts the workshop down, keeps the Designs and rebuilds itself', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, readyToMelt as never);
    await warp(page, MS_PER_SECOND);

    const before = (await snapshot(page)) as StateShape;
    expect(before.designs['money-plate']).toEqual({ level: 4, printsOnLevel: 2 });

    await openTab(page, 'meltdown');
    await expect(page.getByTestId('prestige')).toBeVisible();
    const melt = page.getByTestId('melt-down');
    await expect(melt).toBeEnabled();
    await melt.click();
    await page.getByTestId('melt-down-confirm').click();
    await warp(page, MS_PER_SECOND);

    const after = (await snapshot(page)) as StateShape;
    // The Designs survive **exactly** — the invariant of spec §13.
    expect(after.designs).toEqual(before.designs);
    // Everything else is gone.
    expect(after.upgrades).toEqual({});
    expect(after.resources.parts).toBe(0);
    expect(after.resources.plates).toBeGreaterThan(0);
    expect(after.stats.prestigeCount).toBe(1);

    // And the intro replays itself: no clicks, the pieces clip on by themselves
    // (spec §6 phase 4).
    await expect(workshop(page)).toHaveAttribute('data-self-assembling', 'true');
    await warp(page, 10 * 60 * MS_PER_SECOND);
    const rebuilt = (await snapshot(page)) as StateShape;
    expect(
      (rebuilt as unknown as { assembly: { attachedPieceIds: string[] } }).assembly.attachedPieceIds
        .length,
    ).toBeGreaterThan(0);
    await expect(page.getByTestId('prestige-plates')).toContainText('run 2');
  });

  test('spends the Plates on a press, and the press prints money (spec §5E)', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, (state: unknown) => ({
      ...(readyToMelt(state) as StateShape),
      resources: {
        ...(readyToMelt(state) as StateShape).resources,
        plates: 50,
        money: 0,
      },
      // The presses read Plates *engraved*, not Plates held (spec §5E), so a
      // placed workshop that has fifty in the tin has engraved at least fifty.
      stats: { ...(readyToMelt(state) as StateShape).stats, platesEarned: 50 },
    }));
    await warp(page, MS_PER_SECOND);

    await openTab(page, 'meltdown');
    await page.getByTestId('press-bill-printer').click();
    await warp(page, MS_PER_SECOND);
    expect(((await snapshot(page)) as StateShape).moneyPrinters['bill-printer']).toBe(1);

    // The mint appears in the workshop, and the money starts arriving.
    await expect(workshop(page).locator('[data-testid="mint"]')).toBeVisible();
    await warp(page, 60 * MS_PER_SECOND);
    expect(((await snapshot(page)) as StateShape).stats.moneyPrinted).toBeGreaterThan(0);
  });
});
