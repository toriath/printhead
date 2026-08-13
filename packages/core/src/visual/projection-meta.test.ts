import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import { testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { productValueOf } from '../systems/designs.js';
import { moneyPrintRate, nextMoneyPrinterCost, platesFor } from '../systems/prestige.js';
import { computeModifiers } from '../systems/upgrades.js';
import { toVisualState } from './visual-state.js';

/**
 * The M5 half of the projection (spec §5D, §5E), asserted by *value*.
 *
 * `visual-state.test.ts` pins the contract's shape and the fixture freeze; this
 * pins the arithmetic behind it. Every number here is one a panel renders or a
 * button is disabled by, so "there is a number in the field" is not enough: a
 * studio row that quotes the wrong Product value, or a melt-down that offers
 * Plates it would not actually pay, is worse than one that is missing.
 */
const content = loadContent(RAW_CONTENT);
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });
const capstoneId = content.prestige.requiredDesignId;
const capstone = content.designs.find((def) => def.id === capstoneId);
const pressId = content.prestige.moneyPrinters[0]?.id ?? 'bill-printer';

if (capstone === undefined) {
  throw new Error('content must ship the capstone design prestige.json names');
}

const at = (over: Partial<GameState> = {}): GameState => ({ ...base, ...over });

/** A studio-phase workshop with resin open and Money in the bank. */
const studio = (over: Partial<GameState> = {}): GameState =>
  at({
    phaseId: 'studio',
    upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
    resources: { ...base.resources, money: 1_000_000 },
    ...over,
  });

const studioOf = (state: GameState) => toVisualState(state, content).studio;
const designRow = (state: GameState, designId: string) =>
  studioOf(state).designs.find((row) => row.designId === designId);

describe('the Design Studio panel', () => {
  it('projects every design in content, drafted or not', () => {
    expect(studioOf(base).designs.map((row) => row.designId)).toEqual(
      content.designs.map((def) => def.id),
    );
  });

  it('reports the slot count the tree gives, and how many are free', () => {
    expect(studioOf(base)).toMatchObject({
      slots: content.start.designSlots,
      freeSlots: content.start.designSlots,
    });
    const owned = studio({
      designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } },
      upgrades: { 'sla-unit': 1, 'design-desk': 2 },
    });
    expect(studioOf(owned)).toMatchObject({
      slots: content.start.designSlots + 2,
      freeSlots: content.start.designSlots + 1,
    });
  });

  it('quotes what a Product is worth at the level the Design has reached', () => {
    const state = studio({ designs: { [capstoneId]: { level: 5, printsOnLevel: 1 } } });
    expect(designRow(state, capstoneId)?.productValue).toBe(
      productValueOf(capstone, curves, 5, computeModifiers(state, content)),
    );
    // An unowned Design still quotes a price, at the level it would start on.
    expect(designRow(base, capstoneId)?.productValue).toBe(
      productValueOf(capstone, curves, 1, computeModifiers(base, content)),
    );
  });

  it('reports progress towards the next level, and none once it is capped', () => {
    const half = studio({
      designs: { [capstoneId]: { level: 2, printsOnLevel: capstone.printsPerLevel / 2 } },
    });
    expect(designRow(half, capstoneId)?.levelProgress).toBeCloseTo(0.5, 9);
    const capped = studio({
      designs: { [capstoneId]: { level: capstone.maxLevel, printsOnLevel: 0 } },
    });
    expect(designRow(capped, capstoneId)?.levelProgress).toBe(0);
    expect(designRow(capped, capstoneId)?.level).toBe(capstone.maxLevel);
  });

  it('marks exactly the design prestige.json names as the capstone', () => {
    const flagged = studioOf(base).designs.filter((row) => row.capstone);
    expect(flagged.map((row) => row.designId)).toEqual([capstoneId]);
  });

  it('carries the reason a commission is not on offer', () => {
    expect(designRow(base, capstoneId)).toMatchObject({
      available: false,
      owned: false,
      blockedReason: 'locked',
    });
    expect(designRow(studio({ upgrades: {} }), capstoneId)?.blockedReason).toBe(
      'missing-prerequisite',
    );
    expect(designRow(studio(), capstoneId)).toMatchObject({
      available: true,
      blockedReason: null,
    });
    expect(
      designRow(studio({ designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } } }), capstoneId)
        ?.blockedReason,
    ).toBe('already-owned');
  });

  it('prices the draft and says whether the till can cover it', () => {
    const rich = studio();
    const row = designRow(rich, capstoneId);
    expect(row?.costResource).toBe('money');
    expect(row?.cost).toBeGreaterThan(0);
    expect(row?.affordable).toBe(true);
    const broke = studio({ resources: { ...base.resources, money: 0 } });
    expect(designRow(broke, capstoneId)?.affordable).toBe(false);
  });

  it('shows the bench and how far through the draft it is', () => {
    expect(studioOf(base)).toMatchObject({ draftingDesignId: null, draftProgress: 0 });
    const total = capstone.designDesignMinutes * MS_PER_MINUTE;
    const midway = studio({ studio: { designId: capstoneId, remainingMs: total / 4 } });
    expect(studioOf(midway)).toMatchObject({
      draftingDesignId: capstoneId,
      draftingName: capstone.name,
    });
    expect(studioOf(midway).draftProgress).toBeCloseTo(0.75, 9);
  });
});

describe('the melt-down offer', () => {
  const meltable = (over: Partial<GameState> = {}): GameState =>
    studio({
      phaseId: content.prestige.unlockPhaseId,
      designs: { [capstoneId]: { level: 2, printsOnLevel: 0 } },
      resources: { ...base.resources, money: 4_000_000, plates: 3 },
      ...over,
    });

  it('offers exactly the Plates the melt-down would pay', () => {
    const state = meltable();
    const visual = toVisualState(state, content).prestige;
    expect(visual.platesOnOffer).toBe(platesFor(state, content, curves));
    expect(visual.platesHeld).toBe(3);
    expect(visual.available).toBe(true);
    expect(visual.blockedReason).toBeNull();
  });

  it('carries the reason it is not on offer', () => {
    expect(toVisualState(base, content).prestige).toMatchObject({
      available: false,
      blockedReason: 'locked',
    });
    expect(toVisualState(meltable({ designs: {} }), content).prestige.blockedReason).toBe(
      'missing-prerequisite',
    );
    expect(
      toVisualState(meltable({ resources: { ...base.resources } }), content).prestige.blockedReason,
    ).toBe('not-worth-it');
  });

  it('counts the runs already melted down, and quotes the print rate', () => {
    const state = meltable({
      moneyPrinters: { [pressId]: 2 },
      // The presses read Plates *engraved*, not Plates held (spec §5E), so a
      // workshop that has melted down three times has a rate even after it has
      // spent the proceeds.
      stats: { ...base.stats, prestigeCount: 3, platesEarned: 12 },
    });
    const visual = toVisualState(state, content).prestige;
    expect(visual.runsCompleted).toBe(3);
    expect(visual.moneyPerDesignSecond).toBe(moneyPrintRate(state, content, curves));
    expect(visual.moneyPerDesignSecond).toBeGreaterThan(0);
  });
});

describe('the money printers', () => {
  const banked = (plates: number, over: Partial<GameState> = {}): GameState =>
    studio({
      phaseId: content.prestige.unlockPhaseId,
      resources: { ...base.resources, plates },
      ...over,
    });

  it('projects every tier in content, with its level and its cap', () => {
    expect(toVisualState(base, content).moneyPrinters.map((row) => row.moneyPrinterId)).toEqual(
      content.prestige.moneyPrinters.map((def) => def.id),
    );
    const row = toVisualState(banked(0, { moneyPrinters: { [pressId]: 2 } }), content)
      .moneyPrinters[0];
    expect(row).toMatchObject({ level: 2, maxLevel: content.prestige.moneyPrinters[0]?.maxLevel });
  });

  it('prices the next level exactly as the reducer would charge for it', () => {
    const state = banked(500, { moneyPrinters: { [pressId]: 1 } });
    const cost = nextMoneyPrinterCost(state, content, curves, pressId);
    expect(toVisualState(state, content).moneyPrinters[0]).toMatchObject({
      cost: cost?.amount,
      costResource: 'plates',
      available: true,
      affordable: true,
    });
    expect(toVisualState(banked(0), content).moneyPrinters[0]?.affordable).toBe(false);
  });

  it('closes a tier that is at its cap, and one the phase has not reached', () => {
    const maxed = banked(500, {
      moneyPrinters: { [pressId]: content.prestige.moneyPrinters[0]?.maxLevel ?? 1 },
    });
    expect(toVisualState(maxed, content).moneyPrinters[0]?.available).toBe(false);
    expect(toVisualState(base, content).moneyPrinters[0]?.available).toBe(false);
  });
});

describe('the ledger and the bay output', () => {
  it('publishes Products and Plates alongside the rest of the till', () => {
    const state = at({
      resources: { ...base.resources, products: 7, plates: 4 },
      productsValue: 900,
    });
    expect(toVisualState(state, content).ledger).toMatchObject({ products: 7, plates: 4 });
  });

  it('says whether a bay is making Parts or Products, and which Design', () => {
    const parts = at({
      printers: { 'bench-mk1': 1 },
      slots: [testSlot({ materialId: 'pla', objectId: 'bracket', printerCount: 1 })],
    });
    expect(toVisualState(parts, content).slots[0]).toMatchObject({
      output: 'parts',
      designId: null,
      objectId: 'bracket',
    });

    const products = at({
      printers: { 'bench-mk1': 1 },
      designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } },
      slots: [
        testSlot({
          materialId: capstone.requiredMaterialId,
          objectId: null,
          designId: capstoneId,
          printerCount: 1,
        }),
      ],
    });
    expect(toVisualState(products, content).slots[0]).toMatchObject({
      output: 'products',
      designId: capstoneId,
      // The recipe is named whichever of the pair is loaded, so the renderer
      // and the HUD need no second field.
      objectId: capstoneId,
      objectName: capstone.name,
    });
  });

  it('says when the workshop is rebuilding itself (spec §6 phase 4)', () => {
    expect(toVisualState(base, content).assembly.selfAssembling).toBe(false);
    expect(toVisualState(at({ selfAssembling: true }), content).assembly.selfAssembling).toBe(true);
  });
});
