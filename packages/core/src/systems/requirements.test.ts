import { describe, expect, it } from 'vitest';
import type { Metric } from '../content/schema.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  assemblyProgress,
  countPrinters,
  meetsRequirement,
  meetsRequirements,
  phaseDesignMinutes,
  readMetric,
  requirementProgress,
  totalDesignMinutes,
} from './requirements.js';

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 1 });
const pieceCount = content.start.assemblyPieces.length;

const withState = (over: Partial<GameState>): GameState => ({ ...base, ...over });

describe('countPrinters', () => {
  it('sums every printer def owned', () => {
    expect(countPrinters(base)).toBe(0);
    expect(countPrinters(withState({ printers: { 'bench-mk1': 3, ghost: 2 } }))).toBe(5);
  });
});

describe('assemblyProgress', () => {
  it('is the fraction of pieces attached', () => {
    expect(assemblyProgress(base, content)).toBe(0);
    const half = withState({
      assembly: {
        attachedPieceIds: content.start.assemblyPieces.slice(0, 2).map((p) => p.id),
        cooldownMs: 0,
      },
    });
    expect(assemblyProgress(half, content)).toBeCloseTo(2 / pieceCount, 9);
  });

  it('reaches exactly 1 when the printer is finished', () => {
    const done = withState({
      assembly: { attachedPieceIds: content.start.assemblyPieces.map((p) => p.id), cooldownMs: 0 },
    });
    expect(assemblyProgress(done, content)).toBe(1);
  });

  it('is complete by definition when there are no pieces to attach', () => {
    const empty = { ...content, start: { ...content.start, assemblyPieces: [] } };
    expect(assemblyProgress(base, empty)).toBe(1);
  });
});

describe('design-minute metrics', () => {
  it('measures total time from the simulation clock', () => {
    expect(totalDesignMinutes(withState({ simTimeMs: MS_PER_MINUTE * 3 }))).toBe(3);
  });

  it('measures phase time from when the phase was entered', () => {
    const state = withState({
      simTimeMs: MS_PER_MINUTE * 10,
      phaseEnteredAtMs: MS_PER_MINUTE * 4,
    });
    expect(phaseDesignMinutes(state)).toBe(6);
  });
});

describe('readMetric', () => {
  const state = withState({
    resources: { ...base.resources, parts: 7, scrap: 2, money: 13, products: 6, plates: 4 },
    printers: { 'bench-mk1': 4 },
    designs: {
      'phone-stand': { level: 3, printsOnLevel: 2 },
      'money-plate': { level: 1, printsOnLevel: 0 },
    },
    moneyPrinters: { 'bill-printer': 2 },
    upgrades: { 'heated-bed': 1, 'hardened-nozzle': 2, 'exotic-feedstock': 1 },
    fabricator: { sections: 3, sectionRun: null, run: null, completedAtMs: MS_PER_MINUTE },
    automation: { 'auto-sell': { level: 1, enabled: true, threshold: 40, cooldownMs: 0 } },
    stats: {
      ...base.stats,
      printsCompleted: 11,
      printsFailed: 3,
      partsProduced: 19,
      partsSold: 5,
      moneyEarned: 21,
      filamentPurchasedGrams: 100,
      filamentSoldGrams: 25,
      scrapRecycledGrams: 9,
      productsProduced: 17,
      productsSold: 12,
      moneyPrinted: 33,
      prestigeCount: 2,
      platesEarned: 9,
    },
    assembly: { attachedPieceIds: ['frame', 'gantry'], cooldownMs: 0 },
    simTimeMs: MS_PER_MINUTE * 8,
    phaseEnteredAtMs: MS_PER_MINUTE * 3,
  });

  const expected: Readonly<Record<Metric, number>> = {
    parts: 7,
    scrap: 2,
    money: 13,
    plates: 4,
    products: 6,
    printers: 4,
    slots: 1,
    partsProduced: 19,
    partsSold: 5,
    printsCompleted: 11,
    printsFailed: 3,
    piecesAttached: 2,
    assemblyProgress: 2 / pieceCount,
    upgradesInstalled: 4,
    automationsInstalled: 1,
    scrapRecycledGrams: 9,
    filamentTradedGrams: 125,
    phaseDesignMinutes: 5,
    totalDesignMinutes: 8,
    designs: 2,
    designLevels: 4,
    capstoneDesigned: 1,
    productsProduced: 17,
    productsSold: 12,
    prestigeCount: 2,
    moneyPrinted: 33,
    moneyEarned: 21,
    platesEarned: 9,
    moneyPrintersInstalled: 2,
    endgameNodes: 1,
    fabricatorSections: 3,
    fabricatorComplete: 1,
    // The Fabricator finished one design-minute in and the clock now reads
    // eight, which is well past the whole ending sequence.
    endingComplete: 1,
  };

  it('reads every metric content is allowed to gate on', () => {
    for (const [metric, value] of Object.entries(expected) as [Metric, number][]) {
      expect(readMetric(state, content, metric), metric).toBeCloseTo(value, 9);
    }
  });

  it('covers the whole Metric union — a new metric must be wired up here', () => {
    for (const phase of content.pacing.phases) {
      for (const requirement of phase.advanceWhen) {
        expect(Object.keys(expected)).toContain(requirement.metric);
      }
    }
  });
});

describe('meetsRequirement', () => {
  const state = withState({ resources: { ...base.resources, parts: 5 } });

  it('is satisfied at or above the threshold', () => {
    expect(meetsRequirement(state, content, { metric: 'parts', atLeast: 4 })).toBe(true);
    expect(meetsRequirement(state, content, { metric: 'parts', atLeast: 5 })).toBe(true);
    expect(meetsRequirement(state, content, { metric: 'parts', atLeast: 6 })).toBe(false);
  });

  it('requires every requirement to hold', () => {
    expect(
      meetsRequirements(state, content, [
        { metric: 'parts', atLeast: 5 },
        { metric: 'money', atLeast: 1 },
      ]),
    ).toBe(false);
    expect(
      meetsRequirements(state, content, [
        { metric: 'parts', atLeast: 5 },
        { metric: 'money', atLeast: 0 },
      ]),
    ).toBe(true);
  });
});

describe('requirementProgress', () => {
  it('reports actual against threshold for each gate', () => {
    const state = withState({ resources: { ...base.resources, parts: 3 } });
    expect(
      requirementProgress(state, content, [
        { metric: 'parts', atLeast: 5 },
        { metric: 'scrap', atLeast: 0 },
      ]),
    ).toEqual([
      { metric: 'parts', atLeast: 5, actual: 3, met: false },
      { metric: 'scrap', atLeast: 0, actual: 0, met: true },
    ]);
  });

  it('is empty for an empty gate list', () => {
    expect(requirementProgress(base, content, [])).toEqual([]);
  });
});
