import { expect, test } from '@playwright/test';
import {
  assemblePrinter,
  bootGame,
  replaceState,
  snapshot,
  warp,
  warpPastOffline,
} from './harness.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/**
 * The endgame in a browser (spec §5E, §6 phases 5–6, §7.3).
 *
 * The intro is played for real; the last phase is *placed* with the same
 * dev-only `replaceState` the editor's save-import uses, because four hundred
 * design-minutes of economy is not what this test is about. Everything after
 * that is the shipped UI and the real reducer: the tree is bought because
 * `BUY_UPGRADE` was accepted, the print starts because `START_FABRICATOR` was,
 * and the credits roll because the simulation clock reached them.
 */
interface StateShape {
  readonly phaseId: string;
  readonly slots: readonly { readonly id: string; readonly printerCount: number }[];
  readonly resources: Record<string, number>;
  readonly upgrades: Record<string, number>;
  readonly designs: Record<string, { level: number; printsOnLevel: number }>;
  readonly filamentGrams: Record<string, number>;
  readonly printers: Record<string, number>;
  readonly fabricator: {
    readonly sections: number;
    readonly run: { readonly remainingMs: number } | null;
    readonly completedAtMs: number | null;
  };
  readonly ngPlus: { readonly run: number; readonly modifierIds: readonly string[] };
  readonly stats: Record<string, number>;
}

/**
 * The last phase, with the Plates a melt-down would have left and the giant
 * printer the final print needs (spec §7.3). The endgame tree is *not* granted:
 * the test buys it through the panel.
 */
const inTheEndgame = (state: unknown): unknown => {
  const typed = state as StateShape;
  const first = typed.slots[0];
  return {
    ...typed,
    phaseId: 'end',
    forkId: 'goliath',
    printers: { 'bench-mk1': 24 },
    upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
    resources: { ...typed.resources, parts: 20_000, money: 5_000_000, plates: 200 },
    partsValue: 20_000,
    designs: { 'money-plate': { level: 6, printsOnLevel: 0 } },
    filamentGrams: { ...typed.filamentGrams, pla: 4000 },
    slots: [{ ...first, materialId: 'pla', objectId: 'bracket', printerCount: 24 }],
    stats: { ...typed.stats, prestigeCount: 4, platesEarned: 200, moneyPrinted: 4_000_000 },
  };
};

test.describe('the endgame (spec §5E, §6 phases 5–6)', () => {
  test('buys the tree with Plates, and the economy starts eating itself', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, inTheEndgame as never);
    await warp(page, MS_PER_SECOND);

    // On-screen inflation (spec §6 phase 5): the HUD says what the presses did.
    await expect(page.getByTestId('inflation')).toContainText('×');

    const endgame = page.getByTestId('endgame');
    await expect(endgame).toBeVisible();
    for (const node of ['exotic-feedstock', 'print-a-building', 'print-a-factory']) {
      await expect(page.getByTestId(`buy-${node}`)).toContainText('plates');
      await page.getByTestId(`buy-${node}`).click();
      await warp(page, MS_PER_SECOND);
    }

    const bought = (await snapshot(page)) as StateShape;
    expect(bought.upgrades['print-a-factory']).toBe(1);
    // "Print a building" changes the backdrop (spec §5E).
    await expect(page.getByRole('img').first()).toHaveAttribute('data-backdrop', 'skyline');
    // ...and the printed factory turns out machines on its own.
    await warpPastOffline(page, 10 * MS_PER_MINUTE);
    const later = (await snapshot(page)) as StateShape;
    expect(later.printers['bench-mk1'] ?? 0).toBeGreaterThan(bought.printers['bench-mk1'] ?? 0);
  });

  test('prints the Fabricator layer by layer and rolls the credits', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, inTheEndgame as never);
    await warp(page, MS_PER_SECOND);

    for (const node of [
      'exotic-feedstock',
      'print-a-building',
      'print-a-factory',
      'universal-fabricator',
    ]) {
      await page.getByTestId(`buy-${node}`).click();
      await warp(page, MS_PER_SECOND);
    }

    // The feedstock is bought with Plates (spec §3) — the market row for it
    // only appears once the tree has opened the material, and one click buys a
    // parcel, so the last print takes several.
    const feedstock = page.getByTestId('buy-composite');
    for (let parcel = 0; parcel < 4; parcel += 1) {
      await feedstock.click();
      await warp(page, MS_PER_SECOND);
    }

    // A pre-printed section first (spec §7.3): it shortens the build.
    const section = page.getByTestId('print-section');
    await expect(section).toBeEnabled();
    await section.click();
    await warpPastOffline(page, 5 * MS_PER_MINUTE);
    expect(((await snapshot(page)) as StateShape).fabricator.sections).toBe(1);

    const start = page.getByTestId('start-fabricator');
    await expect(start).toBeEnabled();
    await start.click();
    await warp(page, MS_PER_SECOND);

    // The one synced render: the workshop is the build, drawn layer by layer.
    const build = page.getByTestId('fabricator');
    await expect(build).toBeVisible();
    await warpPastOffline(page, 10 * MS_PER_MINUTE);
    const layer = Number(await build.getAttribute('data-layer'));
    expect(layer).toBeGreaterThan(0);
    await expect(page.getByTestId('fabricator-status')).toContainText(`layer ${layer}`);

    // Run it out: the print lands, the numbers go to ∞, the credits print.
    await warpPastOffline(page, 40 * MS_PER_MINUTE);
    const built = (await snapshot(page)) as StateShape;
    expect(built.fabricator.completedAtMs).not.toBeNull();
    await expect(page.getByTestId('ending')).toBeVisible();

    await warpPastOffline(page, 4 * MS_PER_MINUTE);
    await expect(page.getByTestId('ending')).toHaveAttribute('data-stage', 'complete');
    await expect(page.getByTestId('phase')).toHaveText('ended');
  });

  test('starts a new run on the far side of the credits (spec §18 M6)', async ({ page }) => {
    await bootGame(page);
    await assemblePrinter(page);
    await replaceState(page, (state: unknown) => {
      const typed = inTheEndgame(state) as StateShape;
      // The build already done and the credits already rolled: this test is
      // about what happens *after* the ending, not about reaching it.
      return {
        ...typed,
        fabricator: { sections: 0, sectionRun: null, run: null, completedAtMs: 1000 },
        simTimeMs: 1000 + 10 * MS_PER_MINUTE,
        upgrades: { ...typed.upgrades, 'universal-fabricator': 1 },
      };
    });
    await warp(page, MS_PER_SECOND);

    await expect(page.getByTestId('new-game-plus')).toBeVisible();
    await page.getByTestId('ngplus-veteran-workshop').click();
    await page.getByTestId('start-new-game-plus').click();
    await warp(page, MS_PER_SECOND);

    const restarted = (await snapshot(page)) as StateShape;
    expect(restarted.ngPlus).toEqual({ run: 1, modifierIds: ['veteran-workshop'] });
    // The Designs came with it; nothing else did.
    expect(restarted.designs['money-plate']).toEqual({ level: 6, printsOnLevel: 0 });
    expect(restarted.upgrades).toEqual({});
    expect(restarted.phaseId).toBe('intro');
    await expect(page.getByTestId('phase')).toHaveText('intro');
  });
});
