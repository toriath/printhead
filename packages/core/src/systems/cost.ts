import type { ResourceKind } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { evaluateCurve, evaluateCurveById, getCurve, sumCurve } from '../curves/evaluate.js';

/**
 * Generic cost interpreter: any def that carries `{ costCurveId, costResource }`
 * (printers, upgrades, automation, slots) is priced through here. The numbers
 * come from `content/curves.json`; this file must stay literal-free (spec §11).
 */
export interface Priced {
  readonly costCurveId: string;
  readonly costResource: ResourceKind;
}

export interface Cost {
  readonly resource: ResourceKind;
  readonly amount: number;
}

export function nextCost(curves: CurveRegistry, def: Priced, owned: number): Cost {
  return {
    resource: def.costResource,
    amount: evaluateCurveById(curves, def.costCurveId, owned),
  };
}

export function bulkCost(curves: CurveRegistry, def: Priced, owned: number, count: number): Cost {
  return {
    resource: def.costResource,
    amount: sumCurve(getCurve(curves, def.costCurveId), owned, count),
  };
}

export function canAfford(balance: number, cost: Cost): boolean {
  return balance >= cost.amount;
}

/** How many more units are affordable with `balance`, given `owned` already bought. */
export function affordableCount(
  curves: CurveRegistry,
  def: Priced,
  owned: number,
  balance: number,
): number {
  const curve = getCurve(curves, def.costCurveId);
  let count = 0;
  let spent = 0;
  for (;;) {
    const price = evaluateCurve(curve, owned + count);
    if (price <= 0) {
      throw new RangeError(`cost curve "${def.costCurveId}" is not strictly positive`);
    }
    if (spent + price > balance) {
      return count;
    }
    spent += price;
    count += 1;
  }
}
