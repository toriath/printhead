import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { type Priced, affordableCount, bulkCost, canAfford, nextCost } from './cost.js';

const content = loadContent(RAW_CONTENT);
const curves = createCurveRegistry(content.curves);
const printer = content.printers[0] as Priced;

describe('cost interpreter', () => {
  it('prices the next unit from the def curve', () => {
    const first = nextCost(curves, printer, 0);
    expect(first.resource).toBe('parts');
    expect(first.amount).toBeCloseTo(12, 9);
    expect(nextCost(curves, printer, 1).amount).toBeCloseTo(12 * 1.18, 9);
  });

  it('prices bulk purchases as the sum of consecutive units', () => {
    const bulk = bulkCost(curves, printer, 0, 3);
    const singles =
      nextCost(curves, printer, 0).amount +
      nextCost(curves, printer, 1).amount +
      nextCost(curves, printer, 2).amount;
    expect(bulk.amount).toBeCloseTo(singles, 9);
    expect(bulkCost(curves, printer, 0, 0).amount).toBe(0);
  });

  it('compares a balance against a cost', () => {
    const cost = nextCost(curves, printer, 0);
    expect(canAfford(12, cost)).toBe(true);
    expect(canAfford(11.99, cost)).toBe(false);
  });

  it('counts how many units a balance buys', () => {
    expect(affordableCount(curves, printer, 0, 11)).toBe(0);
    expect(affordableCount(curves, printer, 0, 12)).toBe(1);
    expect(affordableCount(curves, printer, 0, 12 + 12 * 1.18)).toBe(2);
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
