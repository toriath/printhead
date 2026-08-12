import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import type { GameState } from '../state/game-state.js';
import { type Cost, canAfford, nextCost } from './cost.js';
import { drawParts, removeParts, withResource } from './resources.js';

/**
 * Buying and selling (spec §2). Printers are priced from their cost curve
 * (spec §5B) and Parts from the value banked in the inventory when they were
 * printed. Filament is *not* here: it is priced by the market (spec §7.2), and
 * that lives in `market.ts` so there is exactly one place a gram is valued.
 */
const NONE = 0;
const ONE = 1;

export interface SaleResult {
  readonly state: GameState;
  readonly parts: number;
  readonly money: number;
}

/** Sell `requested` parts (or all of them when `null`) at their banked value. */
export function sellPartsFrom(state: GameState, requested: number | null): SaleResult | null {
  const draw = drawParts(state, requested ?? state.resources.parts);
  if (draw.count <= NONE) {
    return null;
  }
  const afterParts = removeParts(state, draw);
  return {
    state: {
      ...afterParts,
      resources: withResource(afterParts.resources, 'money', draw.value),
      stats: {
        ...afterParts.stats,
        partsSold: afterParts.stats.partsSold + draw.count,
        moneyEarned: afterParts.stats.moneyEarned + draw.value,
      },
    },
    parts: draw.count,
    money: draw.value,
  };
}

export function ownedPrinters(state: GameState, printerId: string): number {
  return state.printers[printerId] ?? NONE;
}

/**
 * Printer N costs `base × growth^N` (spec §5B), rounded up when it is priced in
 * a countable resource: you cannot hand over a fraction of a Part.
 */
export function nextPrinterCost(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  printerId: string,
): Cost | null {
  const printer = indexById(content.printers).get(printerId);
  if (printer === undefined) {
    return null;
  }
  const cost = nextCost(curves, printer, ownedPrinters(state, printerId));
  return cost.resource === 'parts' ? { ...cost, amount: Math.ceil(cost.amount) } : cost;
}

/** Pay a content-priced cost out of the ledger; `null` when it is unaffordable. */
export function payCost(state: GameState, cost: Cost): GameState | null {
  if (cost.resource === 'filament') {
    return null;
  }
  if (!canAfford(state.resources[cost.resource], cost)) {
    return null;
  }
  if (cost.resource === 'parts') {
    return removeParts(state, drawParts(state, cost.amount));
  }
  return { ...state, resources: withResource(state.resources, cost.resource, -cost.amount) };
}

export interface PrinterPurchase {
  readonly state: GameState;
  readonly cost: Cost;
  readonly owned: number;
}

export function purchasePrinter(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  printerId: string,
): PrinterPurchase | null {
  const cost = nextPrinterCost(state, content, curves, printerId);
  if (cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const owned = ownedPrinters(state, printerId) + ONE;
  return { cost, owned, state: { ...paid, printers: { ...paid.printers, [printerId]: owned } } };
}

/** Grant the hand-assembled printer #1 — free, and the only printer never bought. */
export function grantPrinter(state: GameState, printerId: string): PrinterPurchase {
  const owned = ownedPrinters(state, printerId) + ONE;
  return {
    cost: { resource: 'parts', amount: NONE },
    owned,
    state: { ...state, printers: { ...state.printers, [printerId]: owned } },
  };
}
