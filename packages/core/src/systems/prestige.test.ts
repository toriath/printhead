import { describe, expect, it } from 'vitest';
import type { Content } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  countMoneyPrinters,
  meltDown,
  moneyPrintRate,
  moneyPrinterAvailability,
  moneyPrinterDef,
  moneyPrinterLevel,
  nextMoneyPrinterCost,
  plateInput,
  platesFor,
  prestigeAvailability,
  purchaseMoneyPrinter,
  tickMoneyPrinting,
} from './prestige.js';

/**
 * The melt-down (spec §5D) and the presses it pays for (spec §5E).
 *
 * The rule these tests care most about is that **nothing here decides what
 * survives**: `retainedResources` and `retainedLedgers` do, so re-pointing them
 * changes the game and changes no code.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 7 });
const capstoneId = content.prestige.requiredDesignId;
const pressId = content.prestige.moneyPrinters[0]?.id ?? 'bill-printer';

/** A workshop that has done everything the melt-down is supposed to scrap. */
const rich = (over: Partial<GameState> = {}): GameState => ({
  ...base,
  phaseId: content.prestige.unlockPhaseId,
  resources: { ...base.resources, money: 1_000_000, parts: 500, scrap: 40, products: 9, plates: 3 },
  partsValue: 700,
  scrapValue: 20,
  productsValue: 4000,
  filamentGrams: { ...base.filamentGrams, pla: 900 },
  printers: { [content.start.printerId]: 12 },
  upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
  forkId: 'farm-path',
  designs: {
    [capstoneId]: { level: 6, printsOnLevel: 2 },
    'phone-stand': { level: 2, printsOnLevel: 1 },
  },
  moneyPrinters: { [pressId]: 2 },
  stats: { ...base.stats, prestigeCount: 1, printsCompleted: 400 },
  ...over,
});

describe('what a melt-down is worth', () => {
  it('reads the resource and scale prestige.json names, nothing else', () => {
    const state = rich();
    expect(plateInput(state, content)).toBeCloseTo(
      state.resources[content.prestige.plateInputResource as 'money'] *
        content.prestige.plateInputScale,
      9,
    );
  });

  it('cannot be driven by filament, which has no single balance to read', () => {
    const perMaterial: Content = {
      ...content,
      prestige: { ...content.prestige, plateInputResource: 'filament' },
    };
    expect(plateInput(rich(), perMaterial)).toBe(0);
    expect(platesFor(rich(), perMaterial, curves)).toBe(0);
  });

  it('pays whole Plates only, and none at all for an empty run', () => {
    const award = platesFor(rich(), content, curves);
    expect(Number.isInteger(award)).toBe(true);
    expect(award).toBeGreaterThan(0);
    expect(platesFor(base, content, curves)).toBe(0);
  });

  it('never pays less for a bigger run', () => {
    let previous = 0;
    for (const money of [0, 1_000, 10_000, 100_000, 1_000_000, 10_000_000]) {
      const award = platesFor(
        { ...rich(), resources: { ...rich().resources, money } },
        content,
        curves,
      );
      expect(award).toBeGreaterThanOrEqual(previous);
      previous = award;
    }
  });
});

describe('whether the workshop may melt itself down', () => {
  it('waits for the phase prestige.json unlocks it in', () => {
    expect(prestigeAvailability(rich({ phaseId: 'bench' }), content, curves)).toBe('locked');
  });

  it('waits for the capstone Design — no Money Plate, no prestige (spec §5D)', () => {
    expect(prestigeAvailability(rich({ designs: {} }), content, curves)).toBe(
      'missing-prerequisite',
    );
  });

  it('refuses a melt-down that would not even be worth the content minimum', () => {
    expect(prestigeAvailability(rich({ resources: { ...base.resources } }), content, curves)).toBe(
      'not-worth-it',
    );
  });

  it('agrees once the run is big enough', () => {
    expect(prestigeAvailability(rich(), content, curves)).toBeNull();
  });
});

describe('the melt-down itself', () => {
  it('awards the Plates it quoted, on top of the ones already held', () => {
    const before = rich();
    const quoted = platesFor(before, content, curves);
    const { state, platesAwarded } = meltDown(before, content, curves);
    expect(platesAwarded).toBe(quoted);
    expect(state.resources.plates).toBe(before.resources.plates + quoted);
  });

  it('scraps the workshop: machines, tree, bays, fork, filament and banked value', () => {
    const { state } = meltDown(rich(), content, curves);
    expect(state.printers).toEqual({});
    expect(state.upgrades).toEqual({});
    expect(state.automation).toEqual({});
    expect(state.forkId).toBeNull();
    expect(state.partsValue).toBe(0);
    expect(state.productsValue).toBe(0);
    expect(state.scrapValue).toBe(0);
    expect(state.resources.parts).toBe(base.resources.parts);
    expect(state.resources.products).toBe(base.resources.products);
    expect(state.slots).toHaveLength(content.start.slotCount);
    expect(state.filamentGrams).toEqual(base.filamentGrams);
  });

  it('keeps the clock, the phase and the rng where the run left them', () => {
    const before = { ...rich(), simTimeMs: 1234, tickCount: 12, phaseEnteredAtMs: 1000 };
    const { state } = meltDown(before, content, curves);
    expect(state.simTimeMs).toBe(1234);
    expect(state.tickCount).toBe(12);
    expect(state.phaseId).toBe(before.phaseId);
    expect(state.phaseEnteredAtMs).toBe(1000);
    expect(state.rng).toBe(before.rng);
  });

  it('carries the Designs across by reference — not remade, not rescaled', () => {
    const before = rich();
    const { state } = meltDown(before, content, curves);
    expect(state.designs).toBe(before.designs);
  });

  it('keeps only the ledgers the content names', () => {
    const designsOnly: Content = {
      ...content,
      prestige: { ...content.prestige, retainedLedgers: ['designs'] },
    };
    const before = rich();
    expect(meltDown(before, designsOnly, curves).state.moneyPrinters).toEqual({});
    expect(meltDown(before, content, curves).state.moneyPrinters).toBe(before.moneyPrinters);
  });

  it('keeps only the balances the content names', () => {
    const platesOnly: Content = {
      ...content,
      prestige: {
        ...content.prestige,
        retainedResources: ['plates'],
        retainedLedgers: ['moneyPrinters'],
      },
    };
    const { state } = meltDown(rich(), platesOnly, curves);
    // `designs` is no longer retained, so the mirror resets with everything else.
    expect(state.resources.designs).toBe(base.resources.designs);
    expect(state.resources.plates).toBeGreaterThan(0);
  });

  it('counts the run and sets the workshop rebuilding itself (spec §6 phase 4)', () => {
    const before = rich();
    const { state } = meltDown(before, content, curves);
    expect(state.stats.prestigeCount).toBe(before.stats.prestigeCount + 1);
    expect(state.stats.printsCompleted).toBe(0);
    expect(state.selfAssembling).toBe(true);
  });

  it('charges the rebuild on top of the first piece’s own bench work', () => {
    const { state } = meltDown(rich(), content, curves);
    expect(state.assembly.attachedPieceIds).toEqual([]);
    expect(state.assembly.cooldownMs).toBe(
      base.assembly.cooldownMs + content.prestige.meltdownDesignSeconds * MS_PER_SECOND,
    );
  });
});

describe('the money printers (spec §5E)', () => {
  it('reads its levels from the ledger, defaulting to none', () => {
    expect(moneyPrinterLevel(base, pressId)).toBe(0);
    expect(moneyPrinterLevel(rich(), pressId)).toBe(2);
    expect(countMoneyPrinters(rich())).toBe(2);
    expect(countMoneyPrinters(base)).toBe(0);
  });

  it('finds a tier by id and nothing by a name content never used', () => {
    expect(moneyPrinterDef(content, pressId)?.id).toBe(pressId);
    expect(moneyPrinterDef(content, 'no-such-press')).toBeUndefined();
  });

  it('prints nothing without Plates, however many presses are installed', () => {
    const platesless = rich({ resources: { ...rich().resources, plates: 0 } });
    expect(moneyPrintRate(platesless, content, curves)).toBe(0);
  });

  it('prints nothing without a press, however many Plates are held', () => {
    expect(moneyPrintRate(rich({ moneyPrinters: {} }), content, curves)).toBe(0);
  });

  it('scales with the installed level as well as the Plates', () => {
    const one = moneyPrintRate(rich({ moneyPrinters: { [pressId]: 1 } }), content, curves);
    const two = moneyPrintRate(rich({ moneyPrinters: { [pressId]: 2 } }), content, curves);
    expect(two).toBeCloseTo(one * 2, 6);
  });

  it('banks what it prints as earned money, and says how much was printed', () => {
    const before = rich();
    const rate = moneyPrintRate(before, content, curves);
    const after = tickMoneyPrinting(before, content, MS_PER_SECOND, curves);
    expect(after.resources.money - before.resources.money).toBeCloseTo(rate, 6);
    expect(after.stats.moneyPrinted).toBeCloseTo(rate, 6);
    expect(after.stats.moneyEarned - before.stats.moneyEarned).toBeCloseTo(rate, 6);
  });

  it('does nothing for a zero-length tick, or with the presses idle', () => {
    const state = rich();
    expect(tickMoneyPrinting(state, content, 0, curves)).toBe(state);
    const idle = rich({ moneyPrinters: {} });
    expect(tickMoneyPrinting(idle, content, MS_PER_SECOND, curves)).toBe(idle);
  });
});

describe('buying a press', () => {
  it('refuses a tier content has never heard of', () => {
    expect(moneyPrinterAvailability(base, content, 'no-such-press')).toBe('unknown-target');
    expect(nextMoneyPrinterCost(base, content, curves, 'no-such-press')).toBeNull();
    expect(purchaseMoneyPrinter(base, content, curves, 'no-such-press')).toBeNull();
  });

  it('refuses before the phase its def unlocks it in', () => {
    expect(moneyPrinterAvailability(base, content, pressId)).toBe('locked');
  });

  it('refuses once the tier is at its cap', () => {
    const def = moneyPrinterDef(content, pressId);
    const maxed = rich({ moneyPrinters: { [pressId]: def?.maxLevel ?? 1 } });
    expect(moneyPrinterAvailability(maxed, content, pressId)).toBe('max-level');
  });

  it('offers it otherwise, priced by the level already installed and in whole Plates', () => {
    expect(moneyPrinterAvailability(rich(), content, pressId)).toBeNull();
    const first = nextMoneyPrinterCost(base, content, curves, pressId);
    const third = nextMoneyPrinterCost(rich(), content, curves, pressId);
    expect(first?.resource).toBe('plates');
    expect(Number.isInteger(first?.amount)).toBe(true);
    expect(third?.amount ?? 0).toBeGreaterThan(first?.amount ?? 0);
  });

  it('leaves a Money-priced press unrounded, because Money is not countable', () => {
    const priced: Content = {
      ...content,
      prestige: {
        ...content.prestige,
        moneyPrinters: content.prestige.moneyPrinters.map((def) => ({
          ...def,
          costResource: 'money' as const,
          costCurveId: 'design-cost',
        })),
      },
    };
    expect(nextMoneyPrinterCost(base, priced, curves, pressId)?.resource).toBe('money');
  });

  it('installs the next level and takes the Plates for it', () => {
    const before = rich({ resources: { ...rich().resources, plates: 500 } });
    const cost = nextMoneyPrinterCost(before, content, curves, pressId);
    const purchase = purchaseMoneyPrinter(before, content, curves, pressId);
    expect(purchase?.level).toBe(3);
    expect(purchase?.state.moneyPrinters[pressId]).toBe(3);
    expect(purchase?.state.resources.plates).toBe(500 - (cost?.amount ?? 0));
  });

  it('will not install one the workshop cannot pay for', () => {
    expect(
      purchaseMoneyPrinter(
        rich({ resources: { ...rich().resources, plates: 0 } }),
        content,
        curves,
        pressId,
      ),
    ).toBeNull();
  });
});
