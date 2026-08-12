import { describe, expect, it } from 'vitest';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  addParts,
  drawParts,
  filamentOf,
  removeParts,
  unitPartValue,
  withFilament,
  withResource,
} from './resources.js';

const base = createInitialState(TEST_CONTENT, { seed: 1 });

/** A ledger holding `count` parts collectively worth `value`. */
const holding = (count: number, value: number): GameState => ({
  ...base,
  resources: { ...base.resources, parts: count },
  partsValue: value,
});

describe('withResource', () => {
  it('adds to a balance without touching the others', () => {
    const next = withResource(base.resources, 'money', 5);
    expect(next.money).toBe(base.resources.money + 5);
    expect(next.parts).toBe(base.resources.parts);
  });

  it('subtracts with a negative amount', () => {
    expect(withResource({ ...base.resources, money: 10 }, 'money', -4).money).toBe(6);
  });
});

describe('withFilament', () => {
  it('adds grams per material', () => {
    expect(withFilament({}, 'pla', 20).pla).toBe(20);
    expect(withFilament({ pla: 5 }, 'pla', 20).pla).toBe(25);
  });

  it('treats an unknown material as empty rather than undefined', () => {
    expect(withFilament({ pla: 5 }, 'petg', 3).petg).toBe(3);
    expect(withFilament({ pla: 5 }, 'petg', 3).pla).toBe(5);
  });

  it('reads back through filamentOf, defaulting to zero', () => {
    const state = { ...base, filamentGrams: { pla: 12 } };
    expect(filamentOf(state, 'pla')).toBe(12);
    expect(filamentOf(state, 'unobtainium')).toBe(0);
  });
});

describe('unitPartValue', () => {
  it('is the average money value of one part in stock', () => {
    expect(unitPartValue(holding(4, 10))).toBe(2.5);
  });

  it('is zero on an empty pool, so nothing divides by zero', () => {
    expect(unitPartValue(holding(0, 0))).toBe(0);
    expect(unitPartValue(holding(0, 99))).toBe(0);
  });
});

describe('drawParts', () => {
  it('takes the requested count and its pro-rata share of the value', () => {
    const draw = drawParts(holding(10, 40), 3);
    expect(draw.count).toBe(3);
    expect(draw.value).toBeCloseTo(12, 9);
  });

  it('clamps to the stock and hands over the whole pool when emptied', () => {
    const draw = drawParts(holding(4, 7), 99);
    expect(draw.count).toBe(4);
    // Exactly the pool, not 4 × (7/4) — no value may be stranded by rounding.
    expect(draw.value).toBe(7);
  });

  it('draws nothing for zero or negative requests', () => {
    expect(drawParts(holding(10, 40), 0)).toEqual({ count: 0, value: 0 });
    expect(drawParts(holding(10, 40), -3)).toEqual({ count: 0, value: 0 });
  });

  it('draws nothing from an empty pool', () => {
    expect(drawParts(holding(0, 0), 5)).toEqual({ count: 0, value: 0 });
  });
});

describe('addParts', () => {
  it('banks the parts and the money they are worth', () => {
    const next = addParts(holding(2, 5), 3, 9);
    expect(next.resources.parts).toBe(5);
    expect(next.partsValue).toBe(14);
  });

  it('ignores a non-positive addition', () => {
    const state = holding(2, 5);
    expect(addParts(state, 0, 9)).toBe(state);
    expect(addParts(state, -1, 9)).toBe(state);
  });
});

describe('removeParts', () => {
  it('removes the count and the drawn value together', () => {
    const state = holding(10, 40);
    const next = removeParts(state, drawParts(state, 3));
    expect(next.resources.parts).toBe(7);
    expect(next.partsValue).toBeCloseTo(28, 9);
  });

  it('zeroes the banked value when the last part leaves', () => {
    const state = holding(3, 7.5);
    const next = removeParts(state, drawParts(state, 3));
    expect(next.resources.parts).toBe(0);
    expect(next.partsValue).toBe(0);
  });

  it('ignores an empty draw', () => {
    const state = holding(3, 7.5);
    expect(removeParts(state, { count: 0, value: 0 })).toBe(state);
  });

  it('round-trips: add then remove everything restores the ledger', () => {
    const state = holding(0, 0);
    const added = addParts(state, 6, 18);
    const emptied = removeParts(added, drawParts(added, 6));
    expect(emptied.resources.parts).toBe(0);
    expect(emptied.partsValue).toBe(0);
  });
});
