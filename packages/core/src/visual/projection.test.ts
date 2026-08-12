import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { Content } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { quoteFor } from '../systems/market.js';
import { toVisualState } from './visual-state.js';

/**
 * The M3 half of the projection, asserted by *value* rather than by shape.
 *
 * `visual-state.test.ts` pins the contract's structure and the fixture freeze;
 * this pins the arithmetic. Every one of these numbers is something a renderer
 * or a button reads directly, so "it is a number in the right field" is not
 * enough — a market row that quotes yesterday's price is worse than one that
 * is missing.
 */
const content = loadContent(RAW_CONTENT);
const RECYCLER_ID = content.failure.recycler.requiresUpgradeId;
const base = createInitialState(content, { seed: 1 });

const at = (over: Partial<GameState> = {}): GameState => ({ ...base, ...over });
const rowFor = (state: GameState, materialId: string) =>
  toVisualState(state, content).market.find((row) => row.materialId === materialId);

describe('the market board', () => {
  it('quotes exactly what the market system would charge', () => {
    const state = at({ phaseId: 'bench', upgrades: { 'heated-bed': 1 } });
    const quote = quoteFor(state, content, 'petg');
    const row = rowFor(state, 'petg');
    expect(row?.buyPerGram).toBe(quote?.buyPerGram);
    expect(row?.sellPerGram).toBe(quote?.sellPerGram);
    expect(row?.priceMultiplier).toBe(quote?.multiplier);
    expect(row?.tradeable).toBe(true);
  });

  it('carries the display name, so the shell needs no content table', () => {
    expect(rowFor(base, 'pla')?.materialName).toBe('PLA');
    expect(rowFor(base, 'petg')?.materialName).toBe('PETG');
  });

  it('reports an unlisted shelf as zero stock rather than Infinity', () => {
    // The schema is finite, and "unlimited" is what `tradeable: false` says.
    const row = rowFor(base, 'pla');
    expect(row?.tradeable).toBe(false);
    expect(row?.stockGrams).toBe(0);
    expect(row?.sellPerGram).toBe(0);
  });

  it('reports the shelf a listed material actually has', () => {
    const state = at({
      phaseId: 'bench',
      upgrades: { 'heated-bed': 1 },
      market: { ...base.market, petg: { stockGrams: 1234, pressure: 0 } },
    });
    expect(rowFor(state, 'petg')?.stockGrams).toBe(1234);
  });

  it('reports what the player is holding, defaulting to nothing', () => {
    const state = at({ filamentGrams: { pla: 77 } });
    expect(rowFor(state, 'pla')?.heldGrams).toBe(77);
    expect(rowFor(state, 'resin')?.heldGrams).toBe(0);
  });

  it('marks a material available only when the phase *and* the tree allow it', () => {
    expect(rowFor(base, 'pla')?.available).toBe(true);
    expect(rowFor(base, 'petg')?.available).toBe(false);
    const bedded = at({ phaseId: 'bench', upgrades: { 'heated-bed': 1 } });
    expect(rowFor(bedded, 'petg')?.available).toBe(true);
    // ...the tree alone is not enough.
    expect(rowFor(at({ upgrades: { 'heated-bed': 1 } }), 'petg')?.available).toBe(false);
  });
});

describe('the machine tree', () => {
  const treeOf = (state: GameState) => toVisualState(state, content).upgrades;
  const nodeOf = (state: GameState, id: string) =>
    treeOf(state).find((row) => row.upgradeId === id);

  it('reports every node, in content order, with its level and ceiling', () => {
    expect(treeOf(base).map((row) => row.upgradeId)).toEqual(content.upgrades.map((def) => def.id));
    const nozzle = nodeOf(at({ upgrades: { 'hardened-nozzle': 2 } }), 'hardened-nozzle');
    expect(nozzle?.level).toBe(2);
    expect(nozzle?.maxLevel).toBe(3);
    expect(nodeOf(base, 'hardened-nozzle')?.level).toBe(0);
  });

  it('names the tree a node belongs to', () => {
    expect(nodeOf(base, 'heated-bed')?.tree).toBe('machine');
    expect(nodeOf(base, 'broker-licence')?.tree).toBe('automation');
  });

  it('prices the *next* level, not the first', () => {
    const first = nodeOf(at({ phaseId: 'bench' }), 'hardened-nozzle')?.cost ?? 0;
    const second =
      nodeOf(at({ phaseId: 'bench', upgrades: { 'hardened-nozzle': 1 } }), 'hardened-nozzle')
        ?.cost ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
  });

  it('separates "you may" from "you can pay"', () => {
    const poor = at({ phaseId: 'bench' });
    expect(nodeOf(poor, 'heated-bed')?.available).toBe(true);
    expect(nodeOf(poor, 'heated-bed')?.affordable).toBe(false);

    const cost = nodeOf(poor, 'heated-bed')?.cost ?? 0;
    const rich = at({
      phaseId: 'bench',
      resources: { ...base.resources, parts: cost },
      partsValue: cost,
    });
    expect(nodeOf(rich, 'heated-bed')?.affordable).toBe(true);
    // A penny short is not affordable.
    const nearly = at({
      phaseId: 'bench',
      resources: { ...base.resources, parts: cost - 1 },
      partsValue: cost - 1,
    });
    expect(nodeOf(nearly, 'heated-bed')?.affordable).toBe(false);
  });

  it('reports the resource a node is priced in', () => {
    expect(nodeOf(base, 'heated-bed')?.costResource).toBe('parts');
    expect(nodeOf(base, 'broker-licence')?.costResource).toBe('money');
  });

  it('marks a maxed node unavailable', () => {
    const maxed = at({ phaseId: 'bench', upgrades: { 'heated-bed': 1 } });
    expect(nodeOf(maxed, 'heated-bed')?.available).toBe(false);
    expect(nodeOf(maxed, 'heated-bed')?.level).toBe(1);
  });

  /** Nothing may ever be "affordable" in filament — that is per material. */
  it('never calls a filament-priced node affordable', () => {
    const filamentPriced: Content = {
      ...content,
      upgrades: content.upgrades.map((def) =>
        def.id === 'heated-bed' ? { ...def, costResource: 'filament' as const } : def,
      ),
    };
    const rich = at({
      phaseId: 'bench',
      resources: { ...base.resources, parts: 1e9, money: 1e9 },
      partsValue: 1e9,
    });
    const row = toVisualState(rich, filamentPriced).upgrades.find(
      (candidate) => candidate.upgradeId === 'heated-bed',
    );
    expect(row?.affordable).toBe(false);
  });
});

describe('the automation rack', () => {
  const rackOf = (state: GameState) => toVisualState(state, content).automation;
  const rowOf = (state: GameState, id: string) =>
    rackOf(state).find((row) => row.automationId === id);

  it('reports every automation with its behaviour', () => {
    expect(rackOf(base).map((row) => row.automationId)).toEqual(
      content.automation.map((def) => def.id),
    );
    expect(rowOf(base, 'auto-sell')?.behavior).toBe('sell-parts');
    expect(rowOf(base, 'auto-trade')?.behavior).toBe('trade-filament');
  });

  it('shows the def default before it is bought, and the player value after', () => {
    const def = content.automation.find((candidate) => candidate.id === 'auto-sell');
    expect(rowOf(base, 'auto-sell')?.threshold).toBe(def?.defaultThreshold);
    expect(rowOf(base, 'auto-sell')?.installed).toBe(false);
    expect(rowOf(base, 'auto-sell')?.enabled).toBe(false);

    const owned = at({
      automation: {
        'auto-sell': { level: 1, enabled: false, threshold: 7, cooldownMs: 0 },
      },
    });
    expect(rowOf(owned, 'auto-sell')?.threshold).toBe(7);
    expect(rowOf(owned, 'auto-sell')?.installed).toBe(true);
    expect(rowOf(owned, 'auto-sell')?.level).toBe(1);
    expect(rowOf(owned, 'auto-sell')?.enabled).toBe(false);
  });

  it('separates "you may" from "you can pay" here too', () => {
    const poor = at({ phaseId: 'bench' });
    expect(rowOf(poor, 'auto-sell')?.available).toBe(true);
    expect(rowOf(poor, 'auto-sell')?.affordable).toBe(false);
    const cost = rowOf(poor, 'auto-sell')?.cost ?? 0;
    const rich = at({
      phaseId: 'bench',
      resources: { ...base.resources, parts: cost },
      partsValue: cost,
    });
    expect(rowOf(rich, 'auto-sell')?.affordable).toBe(true);
  });

  it('marks one gated behind a missing machine node as unavailable', () => {
    const inFarm = at({ phaseId: 'farm', resources: { ...base.resources, money: 1e9 } });
    expect(rowOf(inFarm, 'auto-trade')?.available).toBe(false);
    const licensed = at({
      phaseId: 'farm',
      upgrades: { 'broker-licence': 1 },
      resources: { ...base.resources, money: 1e9 },
    });
    expect(rowOf(licensed, 'auto-trade')?.available).toBe(true);
  });
});

describe('the recycler', () => {
  const recyclerOf = (state: GameState) => toVisualState(state, content).recycler;

  it('is not installed until its node is', () => {
    expect(recyclerOf(base).installed).toBe(false);
    expect(recyclerOf(base).yieldGrams).toBe(0);
    expect(recyclerOf(at({ upgrades: { [RECYCLER_ID]: 1 } })).installed).toBe(true);
  });

  it('quotes the yield in the material the slot is loaded with', () => {
    const state = at({
      upgrades: { [RECYCLER_ID]: 1, 'heated-bed': 1 },
      phaseId: 'bench',
      resources: { ...base.resources, scrap: 100 },
      scrapValue: 10,
      slots: [testSlot({ materialId: 'petg', objectId: 'bracket', printerCount: 1 })],
    });
    const petg = content.materials.find((material) => material.id === 'petg');
    const yieldFraction = content.failure.recycler.yieldFraction;
    expect(recyclerOf(state).yieldMaterialId).toBe('petg');
    expect(recyclerOf(state).yieldGrams).toBeCloseTo(
      (10 * yieldFraction) / (petg?.costPerGram ?? 1),
      9,
    );
    expect(recyclerOf(state).scrapGrams).toBe(100);
  });

  it('falls back to the first material when no slot is loaded', () => {
    const state = at({
      upgrades: { [RECYCLER_ID]: 1 },
      resources: { ...base.resources, scrap: 50 },
      scrapValue: 5,
    });
    expect(recyclerOf(state).yieldMaterialId).toBe(content.materials[0]?.id);
    expect(recyclerOf(state).yieldGrams).toBeGreaterThan(0);
  });

  it('yields nothing from an empty bin', () => {
    expect(recyclerOf(at({ upgrades: { [RECYCLER_ID]: 1 } })).yieldGrams).toBe(0);
  });

  it('yields nothing into a material that is worth nothing', () => {
    const free: Content = {
      ...content,
      materials: content.materials.map((material) =>
        material.id === 'pla' ? { ...material, costPerGram: 0 } : material,
      ),
    };
    const state = at({
      upgrades: { [RECYCLER_ID]: 1 },
      resources: { ...base.resources, scrap: 50 },
      scrapValue: 5,
    });
    expect(toVisualState(state, free).recycler.yieldGrams).toBe(0);
  });
});

describe('a bay mid-changeover and its pity charge', () => {
  const petg = content.materials.find((material) => material.id === 'petg');
  const purgeMs = (petg?.changeoverDesignSeconds ?? 0) * MS_PER_SECOND;

  const slotVisual = (state: GameState) => toVisualState(state, content).slots[0];

  it('is quiet when nothing is purging', () => {
    const state = at({
      printers: { 'bench-mk1': 1 },
      slots: [testSlot({ materialId: 'pla', objectId: 'bracket', printerCount: 1 })],
    });
    expect(slotVisual(state)?.changingOver).toBe(false);
    expect(slotVisual(state)?.changeoverProgress).toBe(0);
  });

  it('reports how far through the purge the bay is', () => {
    const state = at({
      printers: { 'bench-mk1': 1 },
      slots: [
        testSlot({
          materialId: 'petg',
          objectId: 'bracket',
          printerCount: 1,
          changeoverMs: purgeMs / 4,
        }),
      ],
    });
    expect(slotVisual(state)?.changingOver).toBe(true);
    // A quarter of the purge left is three quarters done.
    expect(slotVisual(state)?.changeoverProgress).toBeCloseTo(0.75, 9);
  });

  it('reports the pity charge as a fraction of the threshold', () => {
    const threshold = content.failure.model.chargeThreshold;
    const state = at({
      printers: { 'bench-mk1': 1 },
      slots: [
        testSlot({
          materialId: 'pla',
          objectId: 'bracket',
          printerCount: 1,
          failureCharge: threshold / 2,
        }),
      ],
    });
    expect(slotVisual(state)?.failureRisk).toBeCloseTo(0.5, 9);
  });

  it('clamps an overfull charge to 1 rather than failing the schema', () => {
    const state = at({
      printers: { 'bench-mk1': 1 },
      slots: [
        testSlot({
          materialId: 'pla',
          objectId: 'bracket',
          printerCount: 1,
          failureCharge: content.failure.model.chargeThreshold * 10,
        }),
      ],
    });
    expect(slotVisual(state)?.failureRisk).toBe(1);
  });

  it('shows the machine tree in the bay: a heated bed raises the visible tier', () => {
    const staffed = {
      printers: { 'bench-mk1': 1 },
      slots: [testSlot({ materialId: 'pla', objectId: 'bracket', printerCount: 1 })],
    };
    expect(slotVisual(at(staffed))?.machineTier).toBe(1);
    expect(slotVisual(at({ ...staffed, upgrades: { 'heated-bed': 1 } }))?.machineTier).toBe(2);
    expect(slotVisual(at({ ...staffed, upgrades: { enclosure: 1 } }))?.machineTier).toBe(3);
    // No machine, no tier — an upgrade cannot conjure one.
    expect(toVisualState(at({ upgrades: { enclosure: 1 } }), content).slots[0]?.machineTier).toBe(
      0,
    );
  });
});
