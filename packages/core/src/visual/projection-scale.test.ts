import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { forkCost } from '../systems/forks.js';
import { hardSlotMaximum, nextSlotCost } from '../systems/slots.js';
import { toVisualState } from './visual-state.js';

/**
 * The M4 half of the projection, asserted by *value*.
 *
 * The fleet panel decides nothing for itself: whether a bay is on sale, what it
 * costs, why it is not, which branch of the fork is still open and how many
 * machines a bay may hold are all answers this projection gives. A wrong answer
 * here is a button that lies — either offering a purchase the reducer refuses,
 * or hiding one it would accept.
 */
const content = loadContent(RAW_CONTENT);
const curves = createCurveRegistry(content.curves);
const printerId = content.start.printerId;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
const PER_SLOT = content.start.printersPerSlot;
const base = createInitialState(content, { seed: 1 });

const at = (over: Partial<GameState> = {}): GameState => ({ ...base, ...over });

const bay = (id: string, printerCount = 0, over = {}): ReturnType<typeof testSlot> =>
  testSlot({ id, materialId, objectId, printerCount, ...over });

describe('the fleet summary', () => {
  it('counts the machines, the bays owned, the bays running and the ceiling', () => {
    const state = at({
      phaseId: 'farm',
      printers: { [printerId]: 5 },
      slots: [bay('slot-1', 3), bay('slot-2', 2)],
    });
    expect(toVisualState(state, content).fleet).toEqual({
      printers: 5,
      assigned: 5,
      slotsOwned: 2,
      slotsActive: 2,
      slotsMaximum: hardSlotMaximum(content),
      printerCapacity: PER_SLOT * 2,
    });
  });

  it('reports each bay against its own ceiling', () => {
    const state = at({ phaseId: 'farm', printers: { [printerId]: 1 }, slots: [bay('slot-1', 1)] });
    expect(toVisualState(state, content).slots[0]?.printerCapacity).toBe(PER_SLOT);
  });
});

describe('the next config slot on sale (spec §4)', () => {
  it('quotes the price the reducer would charge', () => {
    const state = at({ phaseId: 'farm', resources: { ...base.resources, parts: 1_000_000 } });
    const unlock = toVisualState(state, content).slotUnlock;
    expect(unlock?.unlockId).toBe('slot-2');
    expect(unlock?.cost).toBe(nextSlotCost(content, curves, 'slot-2')?.amount);
    expect(unlock?.costResource).toBe('parts');
    expect(unlock?.available).toBe(true);
    expect(unlock?.affordable).toBe(true);
    expect(unlock?.blockedReason).toBeNull();
  });

  it('separates "you may" from "you can pay"', () => {
    const broke = at({ phaseId: 'farm' });
    const unlock = toVisualState(broke, content).slotUnlock;
    expect(unlock?.available).toBe(true);
    expect(unlock?.affordable).toBe(false);
  });

  it('says why it is not on offer, rather than just hiding it', () => {
    const early = toVisualState(at({ phaseId: 'bench' }), content).slotUnlock;
    expect(early?.available).toBe(false);
    expect(early?.blockedReason).toBe('locked');
  });

  it('advances to the next bay on the list once one is bought', () => {
    const state = at({ phaseId: 'studio', slots: [bay('slot-1'), bay('slot-2')] });
    const unlock = toVisualState(state, content).slotUnlock;
    expect(unlock?.unlockId).toBe('slot-3');
    expect(unlock?.blockedReason).toBe('missing-prerequisite');
  });

  it('disappears entirely once the rack is at its hard maximum', () => {
    const full = at({
      phaseId: 'prestige',
      slots: ['slot-1', 'slot-2', 'slot-3', 'slot-4'].map((id) => bay(id)),
    });
    expect(toVisualState(full, content).slotUnlock).toBeNull();
  });
});

describe('the Farm/Goliath fork (spec §5B)', () => {
  const studio = (over: Partial<GameState> = {}): GameState =>
    at({
      phaseId: 'studio',
      resources: { ...base.resources, parts: 1_000_000, money: 1_000_000 },
      // Goliath's prerequisites since the M7 rebalance.
      upgrades: { 'sintering-head': 1 },
      stats: { ...base.stats, prestigeCount: 1 },
      ...over,
    });

  it('offers every branch with its price, its description and its layout', () => {
    const forks = toVisualState(studio(), content).forks;
    expect(forks.map((fork) => fork.forkId)).toEqual(content.forks.map((def) => def.id));
    for (const def of content.forks) {
      const row = forks.find((fork) => fork.forkId === def.id);
      expect(row?.name).toBe(def.name);
      expect(row?.description).toBe(def.description);
      expect(row?.layout).toBe(def.visual);
      expect(row?.requiredForFinalPrint).toBe(def.requiredForFinalPrint);
      expect(row?.cost).toBe(forkCost(content, curves, def.id)?.amount);
      expect(row?.costResource).toBe(def.costResource);
      expect(row?.available).toBe(true);
      expect(row?.affordable).toBe(true);
      expect(row?.chosen).toBe(false);
    }
  });

  it('separates "you may" from "you can pay" here too', () => {
    const broke = at({
      phaseId: 'studio',
      upgrades: { 'sintering-head': 1 },
      stats: { ...base.stats, prestigeCount: 1 },
    });
    const forks = toVisualState(broke, content).forks;
    expect(forks.every((fork) => fork.available)).toBe(true);
    expect(forks.every((fork) => !fork.affordable)).toBe(true);
  });

  it('closes every branch once one is committed, and marks the one taken', () => {
    const forks = toVisualState(studio({ forkId: 'farm-path' }), content).forks;
    expect(forks.find((fork) => fork.forkId === 'farm-path')?.chosen).toBe(true);
    expect(forks.every((fork) => !fork.available)).toBe(true);
  });

  it('is closed before its phase', () => {
    expect(toVisualState(at({ phaseId: 'farm' }), content).forks.every((f) => !f.available)).toBe(
      true,
    );
  });
});

describe('the Goliath layout (spec §5B)', () => {
  const melted = (): GameState =>
    at({
      phaseId: 'studio',
      forkId: 'goliath',
      printers: { [printerId]: 9 },
      slots: [bay('slot-1', 9), bay('slot-2'), bay('slot-3')],
    });

  it('draws one bay and says so', () => {
    const visual = toVisualState(melted(), content);
    expect(visual.goliath).toBe(true);
    expect(visual.slotCapacity).toBe(1);
    expect(visual.slots).toHaveLength(1);
    expect(visual.slots[0]?.slotId).toBe('slot-1');
  });

  it('reports the bays it still owns, and the one it is running', () => {
    const visual = toVisualState(melted(), content);
    expect(visual.fleet.slotsOwned).toBe(3);
    expect(visual.fleet.slotsActive).toBe(1);
    // The one bay holds the whole fleet — that is what the fork bought.
    expect(visual.slots[0]?.printerCapacity).toBeGreaterThanOrEqual(9);
    expect(visual.fleet.printerCapacity).toBe(visual.slots[0]?.printerCapacity);
  });

  it('goes back to the rack on the other branch', () => {
    const farm = at({
      phaseId: 'studio',
      forkId: 'farm-path',
      slots: [bay('slot-1'), bay('slot-2')],
    });
    const visual = toVisualState(farm, content);
    expect(visual.goliath).toBe(false);
    expect(visual.slotCapacity).toBe(hardSlotMaximum(content));
    expect(visual.slots).toHaveLength(2);
  });
});

describe('a bay with a print rota (spec §5B)', () => {
  const rota = [
    { materialId, objectId, batches: 3 },
    { materialId: 'petg', objectId, batches: 2 },
  ];

  it('names every entry and marks the one that is loaded', () => {
    const state = at({
      phaseId: 'farm',
      printers: { [printerId]: 1 },
      slots: [bay('slot-1', 1, { queue: rota, queueIndex: 1, queueBatches: 1 })],
    });
    const slot = toVisualState(state, content).slots[0];
    expect(slot?.queue).toEqual([
      {
        materialId,
        materialName: content.materials.find((m) => m.id === materialId)?.name,
        objectId,
        objectName: content.objects.find((o) => o.id === objectId)?.name,
        batches: 3,
        current: false,
      },
      {
        materialId: 'petg',
        materialName: content.materials.find((m) => m.id === 'petg')?.name,
        objectId,
        objectName: content.objects.find((o) => o.id === objectId)?.name,
        batches: 2,
        current: true,
      },
    ]);
    expect(slot?.queueBatches).toBe(1);
  });

  it('drops an entry whose material or object content no longer defines', () => {
    const state = at({
      phaseId: 'farm',
      printers: { [printerId]: 1 },
      slots: [
        bay('slot-1', 1, {
          queue: [{ materialId: 'ghost', objectId, batches: 1 }, ...rota],
        }),
      ],
    });
    // A renamed material must not take the whole panel down with it.
    expect(toVisualState(state, content).slots[0]?.queue).toHaveLength(rota.length);
  });

  it('is empty for a bay printing one configuration', () => {
    const state = at({ phaseId: 'farm', printers: { [printerId]: 1 }, slots: [bay('slot-1', 1)] });
    expect(toVisualState(state, content).slots[0]?.queue).toEqual([]);
    expect(toVisualState(state, content).slots[0]?.queueBatches).toBe(0);
  });
});
