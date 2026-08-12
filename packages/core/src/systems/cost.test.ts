import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import type { CurveDef } from '../curves/schema.js';
import { type Priced, affordableCount, bulkCost, canAfford, nextCost } from './cost.js';

/**
 * The interpreter is tested against a *fixture* curve, not against the shipped
 * balance data: what these tests assert is that `base × growth^N` is computed
 * correctly, and that must not turn red every time the auto-tuner moves a
 * number. The shipped content is checked separately, for shape rather than
 * value, and by the balance budgets in `tools/balance`.
 */
const BASE = 10;
const GROWTH = 1.5;
const fixtureCurve: CurveDef = {
  id: 'test-cost',
  name: 'Test cost',
  type: 'exponential',
  base: BASE,
  growth: GROWTH,
};
const curves = createCurveRegistry([fixtureCurve]);
const priced: Priced = { costCurveId: 'test-cost', costResource: 'parts' };

describe('cost interpreter', () => {
  it('prices the next unit from the def curve', () => {
    const first = nextCost(curves, priced, 0);
    expect(first.resource).toBe('parts');
    expect(first.amount).toBeCloseTo(BASE, 9);
    expect(nextCost(curves, priced, 1).amount).toBeCloseTo(BASE * GROWTH, 9);
    expect(nextCost(curves, priced, 3).amount).toBeCloseTo(BASE * GROWTH ** 3, 9);
  });

  it('prices bulk purchases as the sum of consecutive units', () => {
    const bulk = bulkCost(curves, priced, 0, 3);
    const singles =
      nextCost(curves, priced, 0).amount +
      nextCost(curves, priced, 1).amount +
      nextCost(curves, priced, 2).amount;
    expect(bulk.amount).toBeCloseTo(singles, 9);
    expect(bulkCost(curves, priced, 0, 0).amount).toBe(0);
  });

  it('compares a balance against a cost', () => {
    const cost = nextCost(curves, priced, 0);
    expect(canAfford(BASE, cost)).toBe(true);
    expect(canAfford(BASE - 0.01, cost)).toBe(false);
  });

  it('counts how many units a balance buys', () => {
    expect(affordableCount(curves, priced, 0, BASE - 1)).toBe(0);
    expect(affordableCount(curves, priced, 0, BASE)).toBe(1);
    expect(affordableCount(curves, priced, 0, BASE + BASE * GROWTH)).toBe(2);
  });

  it('counts from the units already owned, not from zero', () => {
    // The second unit alone costs BASE × GROWTH, so BASE is no longer enough.
    expect(affordableCount(curves, priced, 1, BASE)).toBe(0);
    expect(affordableCount(curves, priced, 1, BASE * GROWTH)).toBe(1);
  });

  it('names the offending curve when it is not strictly positive', () => {
    const freeCurves = createCurveRegistry([
      { id: 'free', name: 'free', type: 'constant', value: 0 },
    ]);
    expect(() =>
      affordableCount(freeCurves, { costCurveId: 'free', costResource: 'parts' }, 0, 10),
    ).toThrow('cost curve "free" is not strictly positive');
  });

  it('refuses to count against a non-positive cost curve', () => {
    const freeCurves = createCurveRegistry([
      { id: 'free', name: 'free', type: 'constant', value: 0 },
    ]);
    const free: Priced = { costCurveId: 'free', costResource: 'parts' };
    expect(() => affordableCount(freeCurves, free, 0, 10)).toThrow(RangeError);
  });

  it('fails loudly on a missing curve', () => {
    expect(() => nextCost(curves, { costCurveId: 'ghost', costResource: 'parts' }, 0)).toThrow();
  });
});

describe('the shipped printer is priced off a curve', () => {
  const content = loadContent(RAW_CONTENT);
  const shipped = createCurveRegistry(content.curves);
  const printer = content.printers[0] as Priced | undefined;

  it('grows with each unit owned (spec §5B: base × growth^N)', () => {
    expect(printer).toBeDefined();
    if (printer === undefined) {
      return;
    }
    const prices = [0, 1, 2, 3].map((owned) => nextCost(shipped, printer, owned).amount);
    for (let i = 1; i < prices.length; i += 1) {
      expect(prices[i]).toBeGreaterThan(prices[i - 1] ?? 0);
    }
    expect(nextCost(shipped, printer, 0).resource).toBe('parts');
  });
});
