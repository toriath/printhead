import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type AssemblyState, type GameState, createInitialState } from '../state/game-state.js';
import { attachAssemblyPiece, attachCooldownMs, nextPiece, tickAssembly } from './assembly.js';
import {
  affordableGrams,
  filamentPrice,
  grantPrinter,
  nextPrinterCost,
  ownedPrinters,
  payCost,
  purchaseFilament,
  purchasePrinter,
  sellPartsFrom,
} from './economy.js';

const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const printerId = content.start.printerId;
const base = createInitialState(content, { seed: 1 });
const pla = content.materials[0] as MaterialDef;

const holding = (parts: number, value: number, money = 0): GameState => ({
  ...base,
  resources: { ...base.resources, parts, money },
  partsValue: value,
});

describe('sellPartsFrom', () => {
  it('sells the requested count at its banked value', () => {
    const sale = sellPartsFrom(holding(10, 40), 4);
    expect(sale?.parts).toBe(4);
    expect(sale?.money).toBeCloseTo(16, 9);
    expect(sale?.state.resources.money).toBeCloseTo(16, 9);
    expect(sale?.state.resources.parts).toBe(6);
    expect(sale?.state.stats.partsSold).toBe(4);
    expect(sale?.state.stats.moneyEarned).toBeCloseTo(16, 9);
  });

  it('sells the whole pool when the count is null', () => {
    const sale = sellPartsFrom(holding(3, 9), null);
    expect(sale?.parts).toBe(3);
    expect(sale?.money).toBe(9);
    expect(sale?.state.partsValue).toBe(0);
  });

  it('is null when there is nothing to sell', () => {
    expect(sellPartsFrom(holding(0, 0), null)).toBeNull();
    expect(sellPartsFrom(holding(5, 5), 0)).toBeNull();
    expect(sellPartsFrom(holding(5, 5), -2)).toBeNull();
  });
});

describe('filament pricing', () => {
  it('prices grams from the material def', () => {
    expect(filamentPrice(pla, 100)).toBeCloseTo(pla.costPerGram * 100, 9);
  });

  it('reports how many grams a balance buys', () => {
    expect(affordableGrams(pla, 10)).toBeCloseTo(10 / pla.costPerGram, 9);
  });

  it('treats a free material as unlimited rather than dividing by zero', () => {
    expect(affordableGrams({ ...pla, costPerGram: 0 }, 10)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('purchaseFilament', () => {
  it('exchanges money for grams and books the stat', () => {
    const state = holding(0, 0, 10);
    const bought = purchaseFilament(state, content, pla.id, 100);
    expect(bought?.cost).toBeCloseTo(pla.costPerGram * 100, 9);
    expect(bought?.state.filamentGrams[pla.id]).toBe((state.filamentGrams[pla.id] ?? 0) + 100);
    expect(bought?.state.resources.money).toBeCloseTo(10 - (bought?.cost ?? 0), 9);
    expect(bought?.state.stats.filamentPurchasedGrams).toBe(100);
  });

  it('refuses an unaffordable order rather than going into debt', () => {
    expect(purchaseFilament(holding(0, 0, 1), content, pla.id, 1_000_000)).toBeNull();
  });

  it('refuses unknown materials and nonsensical quantities', () => {
    const rich = holding(0, 0, 1000);
    expect(purchaseFilament(rich, content, 'unobtainium', 10)).toBeNull();
    expect(purchaseFilament(rich, content, pla.id, 0)).toBeNull();
    expect(purchaseFilament(rich, content, pla.id, -10)).toBeNull();
    expect(purchaseFilament(rich, content, pla.id, Number.NaN)).toBeNull();
    expect(purchaseFilament(rich, content, pla.id, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('printer pricing', () => {
  it('counts what is already owned', () => {
    expect(ownedPrinters(base, printerId)).toBe(0);
    expect(ownedPrinters({ ...base, printers: { [printerId]: 3 } }, printerId)).toBe(3);
  });

  it('rounds a parts price up — you cannot hand over a fraction of a Part', () => {
    const cost = nextPrinterCost(base, content, curves, printerId);
    expect(cost?.resource).toBe('parts');
    expect(Number.isInteger(cost?.amount)).toBe(true);
  });

  it('is null for an unknown printer', () => {
    expect(nextPrinterCost(base, content, curves, 'ghost')).toBeNull();
  });
});

describe('payCost', () => {
  it('deducts a scalar resource', () => {
    const paid = payCost(holding(0, 0, 10), { resource: 'money', amount: 4 });
    expect(paid?.resources.money).toBe(6);
  });

  it('deducts parts together with their banked value', () => {
    const paid = payCost(holding(10, 40), { resource: 'parts', amount: 4 });
    expect(paid?.resources.parts).toBe(6);
    expect(paid?.partsValue).toBeCloseTo(24, 9);
  });

  it('is null when the ledger is short', () => {
    expect(payCost(holding(0, 0, 3), { resource: 'money', amount: 4 })).toBeNull();
  });

  it('refuses to price anything in filament — that is per material, not scalar', () => {
    expect(payCost(holding(0, 0, 100), { resource: 'filament', amount: 1 })).toBeNull();
  });
});

describe('purchasePrinter', () => {
  it('pays the curve price and increments the count', () => {
    const price = nextPrinterCost(base, content, curves, printerId);
    const rich = holding(price?.amount ?? 0, price?.amount ?? 0);
    const bought = purchasePrinter(rich, content, curves, printerId);
    expect(bought?.owned).toBe(1);
    expect(bought?.state.printers[printerId]).toBe(1);
    expect(bought?.state.resources.parts).toBe(0);
  });

  it('is null when unaffordable or unknown', () => {
    expect(purchasePrinter(base, content, curves, printerId)).toBeNull();
    expect(purchasePrinter(base, content, curves, 'ghost')).toBeNull();
  });
});

describe('grantPrinter', () => {
  it('hands over printer #1 free — the only one never bought', () => {
    const granted = grantPrinter(base, printerId);
    expect(granted.owned).toBe(1);
    expect(granted.cost.amount).toBe(0);
    expect(granted.state.resources.parts).toBe(base.resources.parts);
  });

  it('stacks on top of printers already owned', () => {
    expect(grantPrinter({ ...base, printers: { [printerId]: 2 } }, printerId).owned).toBe(3);
  });
});

describe('intro assembly', () => {
  const pieces = content.start.assemblyPieces;
  const first = pieces[0];
  const second = pieces[1];

  it('converts authored seconds into the tick clock', () => {
    expect(attachCooldownMs(first)).toBe((first?.attachDesignSeconds ?? 0) * 1000);
    expect(attachCooldownMs(undefined)).toBe(0);
  });

  it('burns bench work down to exactly zero and no further', () => {
    let assembly: AssemblyState = { attachedPieceIds: [], cooldownMs: 1000 };
    assembly = tickAssembly(assembly, 400);
    expect(assembly.cooldownMs).toBe(600);
    assembly = tickAssembly(assembly, 9999);
    expect(assembly.cooldownMs).toBe(0);
    // Already at zero: unchanged, and the same object.
    expect(tickAssembly(assembly, 100)).toBe(assembly);
  });

  it('refuses a piece that is out of order or not yet prepared', () => {
    const fresh = { attachedPieceIds: [], cooldownMs: attachCooldownMs(first) };
    expect(attachAssemblyPiece(fresh, content, second?.id ?? '')).toEqual({
      ok: false,
      reason: 'out-of-order',
    });
    expect(attachAssemblyPiece(fresh, content, first?.id ?? '')).toEqual({
      ok: false,
      reason: 'not-ready',
    });
  });

  it('attaches a ready piece and queues the next one', () => {
    const ready = { attachedPieceIds: [], cooldownMs: 0 };
    const result = attachAssemblyPiece(ready, content, first?.id ?? '');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.assembly.attachedPieceIds).toEqual([first?.id]);
    expect(result.assembly.cooldownMs).toBe(attachCooldownMs(second));
  });

  it('has no next piece once every piece is on', () => {
    const done = { attachedPieceIds: pieces.map((p) => p.id), cooldownMs: 0 };
    expect(nextPiece(done, content)).toBeNull();
    expect(attachAssemblyPiece(done, content, first?.id ?? '')).toEqual({
      ok: false,
      reason: 'out-of-order',
    });
  });
});
