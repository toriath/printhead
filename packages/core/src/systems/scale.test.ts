import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { RawContent } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  assignPrinters,
  fleetCapacity,
  isActiveSlot,
  printersPerSlot,
  slotRoom,
  slotWithRoom,
} from './fleet.js';
import { chosenFork, commitFork, consolidateSlots, forkAvailability, forkCost } from './forks.js';
import {
  effectiveSlotCapacity,
  hardSlotMaximum,
  nextSlotCost,
  nextSlotUnlock,
  ownedSlotCount,
  purchaseSlot,
  purchasedSlotCount,
  slotUnlockAvailability,
} from './slots.js';

/**
 * Slots and scale (spec §4, §5B) at the systems level: the bay progression, the
 * fleet allocator and the per-run fork. The reducer tests drive these through
 * whole games; the branches that only a broken caller can reach — an unknown
 * bay, a full bay, a fork bought twice — are tested here directly.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const printerId = content.start.printerId;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
const PER_SLOT = content.start.printersPerSlot;
const GOLIATH = 'goliath';
const FARM = 'farm-path';

/** A workshop parked in `phaseId` with `slots` bays and some machines. */
function world(over: Partial<GameState> = {}): GameState {
  return {
    ...createInitialState(content, { seed: 1 }),
    phaseId: 'farm',
    printers: { [printerId]: 1 },
    slots: [testSlot({ id: 'slot-1', materialId, objectId, printerCount: 1 })],
    ...over,
  };
}

function withParts(state: GameState, parts: number): GameState {
  return { ...state, resources: { ...state.resources, parts }, partsValue: parts };
}

describe('the config-slot progression (spec §4)', () => {
  it('derives the hard maximum from the unlock list, not from a second number', () => {
    expect(hardSlotMaximum(content)).toBe(content.start.slotCount + content.slots.length);
    expect(hardSlotMaximum(content)).toBe(4);
  });

  it('counts owned bays and how many of the unlocks were bought', () => {
    const one = world();
    expect(ownedSlotCount(one)).toBe(1);
    expect(purchasedSlotCount(one, content)).toBe(0);
    const two = world({ slots: [testSlot({ id: 'slot-1' }), testSlot({ id: 'slot-2' })] });
    expect(purchasedSlotCount(two, content)).toBe(1);
    expect(nextSlotUnlock(two, content)?.id).toBe('slot-3');
  });

  it('sells bays in content order and refuses a skipped one', () => {
    const state = world();
    expect(slotUnlockAvailability(state, content, 'slot-2')).toBeNull();
    expect(slotUnlockAvailability(state, content, 'slot-3')).toBe('out-of-order');
    expect(slotUnlockAvailability(state, content, 'nope')).toBe('unknown-target');
  });

  it('locks a bay whose phase has not arrived', () => {
    expect(slotUnlockAvailability(world({ phaseId: 'bench' }), content, 'slot-2')).toBe('locked');
  });

  it('locks a bay whose machine-tree prerequisite is missing', () => {
    const state = world({
      phaseId: 'studio',
      slots: [testSlot({ id: 'slot-1' }), testSlot({ id: 'slot-2' })],
    });
    expect(slotUnlockAvailability(state, content, 'slot-3')).toBe('missing-prerequisite');
    const built = { ...state, upgrades: { enclosure: 1 } };
    expect(slotUnlockAvailability(built, content, 'slot-3')).toBeNull();
  });

  /**
   * Slot 4 is the prestige gate of spec §4. Nothing in M4 can mint a Plate, so
   * the bay is shut — and the assertion that proves the gate is *real* rather
   * than merely unreachable is the one that opens it by granting one.
   */
  it('keeps the fourth bay shut until prestige mints a Plate', () => {
    const rack = ['slot-1', 'slot-2', 'slot-3'].map((id) => testSlot({ id }));
    const state = world({ phaseId: 'prestige', slots: rack, upgrades: { enclosure: 1 } });
    expect(slotUnlockAvailability(state, content, 'slot-4')).toBe('locked');
    const prestiged = { ...state, resources: { ...state.resources, plates: 1 } };
    expect(slotUnlockAvailability(prestiged, content, 'slot-4')).toBeNull();
  });

  it('reports "max-level" once every bay has been bought', () => {
    const full = world({ slots: ['a', 'b', 'c', 'd'].map((id) => testSlot({ id })) });
    expect(nextSlotUnlock(full, content)).toBeNull();
    expect(slotUnlockAvailability(full, content, 'slot-2')).toBe('max-level');
  });

  it('prices each bay from its position on the list — slot 3 is the expensive one', () => {
    const second = nextSlotCost(content, curves, 'slot-2')?.amount ?? 0;
    const third = nextSlotCost(content, curves, 'slot-3')?.amount ?? 0;
    expect(third).toBeGreaterThan(second);
    expect(nextSlotCost(content, curves, 'nope')).toBeNull();
  });

  it('appends a bay and charges for it', () => {
    const cost = nextSlotCost(content, curves, 'slot-2')?.amount ?? 0;
    const purchase = purchaseSlot(withParts(world(), cost), content, curves, 'slot-2');
    expect(purchase?.slotId).toBe('slot-2');
    expect(purchase?.state.slots).toHaveLength(2);
    expect(purchase?.state.resources.parts).toBe(0);
  });

  it('refuses a bay the ledger cannot pay for, and one that does not exist', () => {
    expect(purchaseSlot(world(), content, curves, 'slot-2')).toBeNull();
    expect(purchaseSlot(withParts(world(), 1e6), content, curves, 'nope')).toBeNull();
  });
});

describe('fleet allocation (spec §4)', () => {
  const two = (a: number, b: number): GameState =>
    world({
      printers: { [printerId]: a + b },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: a }),
        testSlot({ id: 'slot-2', materialId, objectId, printerCount: b }),
      ],
    });

  it('caps how many machines a bay can hold', () => {
    expect(printersPerSlot(world(), content)).toBe(PER_SLOT);
    expect(slotRoom(two(PER_SLOT, 0), content, two(PER_SLOT, 0).slots[0]!)).toBe(0);
    expect(fleetCapacity(two(1, 1), content, 2)).toBe(PER_SLOT * 2);
  });

  it('finds the bay a new machine could stand in, or reports the rack full', () => {
    expect(slotWithRoom(two(1, 0), content)?.id).toBe('slot-1');
    expect(slotWithRoom(two(PER_SLOT, 1), content)?.id).toBe('slot-2');
    expect(slotWithRoom(two(PER_SLOT, PER_SLOT), content)).toBeNull();
  });

  it('moves machines between bays without changing the fleet', () => {
    const move = assignPrinters(two(4, 0), content, 'slot-1', 'slot-2', 3);
    if (typeof move === 'string') {
      throw new Error(move);
    }
    expect(move.moved).toBe(3);
    expect(move.state.slots.map((slot) => slot.printerCount)).toEqual([1, 3]);
  });

  it('clamps to what the source has and to the room the target has left', () => {
    const greedy = assignPrinters(two(2, 0), content, 'slot-1', 'slot-2', 99);
    expect(typeof greedy === 'string' ? greedy : greedy.moved).toBe(2);
    const cramped = assignPrinters(two(3, PER_SLOT - 1), content, 'slot-1', 'slot-2', 3);
    expect(typeof cramped === 'string' ? cramped : cramped.moved).toBe(1);
  });

  it('refuses moves that cannot mean anything', () => {
    expect(assignPrinters(two(1, 1), content, 'slot-1', 'slot-1', 1)).toBe('nothing-to-do');
    expect(assignPrinters(two(1, 1), content, 'slot-1', 'ghost', 1)).toBe('unknown-target');
    expect(assignPrinters(two(1, 1), content, 'slot-1', 'slot-2', 0)).toBe('nothing-to-do');
    expect(assignPrinters(two(0, 1), content, 'slot-1', 'slot-2', 1)).toBe(
      'insufficient-resources',
    );
    expect(assignPrinters(two(1, PER_SLOT), content, 'slot-1', 'slot-2', 1)).toBe('slot-full');
  });

  /**
   * Filament for a batch is consumed when the batch starts, so machines walking
   * out mid-run cannot be refunded — the run simply finishes with however many
   * printers are left standing over it.
   */
  it('shrinks a batch in flight to the machines that stayed', () => {
    const running = two(4, 0);
    const withRun: GameState = {
      ...running,
      slots: running.slots.map((slot, index) =>
        index === 0 ? { ...slot, run: { remainingMs: 500, totalMs: 1000, batch: 4 } } : slot,
      ),
    };
    const move = assignPrinters(withRun, content, 'slot-1', 'slot-2', 3);
    if (typeof move === 'string') {
      throw new Error(move);
    }
    expect(move.state.slots[0]?.run?.batch).toBe(1);
  });

  it('cancels a run the last machine walked out on', () => {
    const running = two(2, 0);
    const withRun: GameState = {
      ...running,
      slots: running.slots.map((slot, index) =>
        index === 0 ? { ...slot, run: { remainingMs: 500, totalMs: 1000, batch: 2 } } : slot,
      ),
    };
    const move = assignPrinters(withRun, content, 'slot-1', 'slot-2', 2);
    expect(typeof move === 'string' ? move : move.state.slots[0]?.run).toBeNull();
  });
});

describe('the Farm/Goliath fork (spec §5B)', () => {
  // The fork is priced in money since the M7 rebalance; fund both so these
  // tests are about the fork, not about which currency it happens to cost.
  // Goliath needs a sintering head and one melt-down behind it since the M7
  // rebalance; this workshop has both, so the tests are about the fork.
  const studio = (over: Partial<GameState> = {}): GameState => {
    const base = world({ phaseId: 'studio', upgrades: { 'sintering-head': 1 }, ...over });
    const funded = withParts({ ...base, stats: { ...base.stats, prestigeCount: 1 } }, 5000);
    return { ...funded, resources: { ...funded.resources, money: 1_000_000 } };
  };

  it('keeps Goliath shut until a melt-down and a sintering head are behind the run', () => {
    const fresh = world({ phaseId: 'studio' });
    expect(forkAvailability(fresh, content, GOLIATH)).toBe('missing-prerequisite');
    expect(forkAvailability(fresh, content, FARM)).toBeNull();
    const headed = { ...fresh, upgrades: { 'sintering-head': 1 } };
    expect(forkAvailability(headed, content, GOLIATH)).not.toBeNull();
    expect(forkAvailability(studio(), content, GOLIATH)).toBeNull();
  });

  it('offers both branches until one is taken, then neither', () => {
    const open = studio();
    expect(forkAvailability(open, content, FARM)).toBeNull();
    expect(forkAvailability(open, content, GOLIATH)).toBeNull();
    const committed = { ...open, forkId: FARM };
    expect(forkAvailability(committed, content, GOLIATH)).toBe('max-level');
    expect(forkAvailability(committed, content, FARM)).toBe('max-level');
  });

  it('locks the fork until its phase and rejects an unknown branch', () => {
    expect(forkAvailability(studio({ phaseId: 'farm' }), content, FARM)).toBe('locked');
    expect(forkAvailability(studio(), content, 'nope')).toBe('unknown-target');
    expect(forkCost(content, curves, 'nope')).toBeNull();
  });

  it('records the commitment and charges for it', () => {
    const cost = forkCost(content, curves, FARM);
    if (cost === null || cost.resource === 'filament') {
      throw new Error('expected the fork to cost a resource');
    }
    const before = studio();
    const choice = commitFork(before, content, curves, FARM);
    expect(choice?.state.forkId).toBe(FARM);
    expect(choice?.state.resources[cost.resource]).toBe(
      before.resources[cost.resource] - cost.amount,
    );
    expect(chosenFork(choice?.state as GameState, content)?.id).toBe(FARM);
  });

  it('refuses a branch nobody can pay for', () => {
    expect(commitFork(world({ phaseId: 'studio' }), content, curves, FARM)).toBeNull();
    expect(commitFork(studio(), content, curves, 'nope')).toBeNull();
  });

  it('reports no fork before the choice is made', () => {
    expect(chosenFork(studio(), content)).toBeNull();
  });

  /**
   * Goliath is not a label the code recognises: it is simply the branch whose
   * `slotCapacity` is one. Committing melts the rack into that single bay.
   */
  it('melts the rack into one machine when the branch caps the bays', () => {
    const rack = studio({
      printers: { [printerId]: 9 },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: 5 }),
        testSlot({
          id: 'slot-2',
          materialId,
          objectId,
          printerCount: 4,
          queue: [{ materialId, objectId, batches: 2 }],
          run: { remainingMs: 100, totalMs: 200, batch: 4 },
        }),
      ],
    });
    const choice = commitFork(rack, content, curves, GOLIATH);
    const slots = choice?.state.slots ?? [];
    expect(slots[0]?.printerCount).toBe(9);
    expect(slots[1]?.printerCount).toBe(0);
    expect(slots[1]?.run).toBeNull();
    expect(slots[1]?.queue).toEqual([]);
    // The stripped bays must not quietly re-arm themselves either.
    expect(slots[1]?.autoRestart).toBe(false);
    expect(slots[1]?.materialId).toBeNull();
    expect(effectiveSlotCapacity(choice?.state as GameState, content)).toBe(1);
    // …and that one bay is allowed to hold the whole fleet.
    expect(printersPerSlot(choice?.state as GameState, content)).toBeGreaterThanOrEqual(9);
  });

  /**
   * Both fields the branch defs carry that today's content never exercises: a
   * machine-tree prerequisite (both shipped branches have none) and a price
   * that is not already a whole number of Parts. Content will grow both, and a
   * gate nothing tests is a gate that breaks silently when it does.
   */
  it('honours a prerequisite and rounds a fractional price, on content that has them', () => {
    const raw = JSON.parse(JSON.stringify(RAW_CONTENT)) as RawContent;
    const forks = raw.forks as { id: string; requiresUpgradeIds: string[]; costResource: string }[];
    const first = forks[0];
    if (first === undefined) {
      throw new Error('expected a fork def');
    }
    first.requiresUpgradeIds = ['enclosure'];
    // Whole units are a Parts rule; money keeps its cents.
    first.costResource = 'parts';
    const curveList = raw.curves as { id: string; value?: number }[];
    const forkCurve = curveList.find((curve) => curve.id === 'fork-cost');
    if (forkCurve === undefined) {
      throw new Error('expected the fork cost curve');
    }
    forkCurve.value = 1200.4;
    const gated = loadContent(raw);
    const gatedCurves = createCurveRegistry(gated.curves);

    const before = withParts(world({ phaseId: 'studio' }), 5000);
    expect(forkAvailability(before, gated, first.id)).toBe('missing-prerequisite');
    const built = { ...before, upgrades: { enclosure: 1 } };
    expect(forkAvailability(built, gated, first.id)).toBeNull();
    expect(forkCost(gated, gatedCurves, first.id)?.amount).toBe(1201);
  });

  it('leaves the rack alone when the branch does not cap it', () => {
    const rack = studio({
      slots: [testSlot({ id: 'slot-1', printerCount: 1 }), testSlot({ id: 'slot-2' })],
    });
    const choice = commitFork(rack, content, curves, FARM);
    expect(choice?.state.slots).toHaveLength(2);
    expect(effectiveSlotCapacity(choice?.state as GameState, content)).toBe(2);
  });

  /**
   * The bays the melt-down emptied are not merely hidden: nothing may be put
   * back into them. Without this the projection would draw one machine while
   * the reducer quietly housed the next purchase in a bay nobody can see.
   */
  it('closes the bays it melted down to any new machine', () => {
    const rack = studio({
      printers: { [printerId]: 4 },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: 2 }),
        testSlot({ id: 'slot-2', materialId, objectId, printerCount: 2 }),
      ],
    });
    const after = commitFork(rack, content, curves, GOLIATH)?.state as GameState;
    expect(isActiveSlot(after, content, 'slot-1')).toBe(true);
    expect(isActiveSlot(after, content, 'slot-2')).toBe(false);
    expect(slotRoom(after, content, after.slots[1] as never)).toBe(0);
    expect(slotWithRoom(after, content)?.id).toBe('slot-1');
    expect(assignPrinters(after, content, 'slot-1', 'slot-2', 1)).toBe('slot-full');
  });

  it('consolidates nothing when the rack already fits', () => {
    const slots = [testSlot({ id: 'slot-1', printerCount: 2 })];
    expect(consolidateSlots(slots, 1)).toBe(slots);
    expect(consolidateSlots([], 1)).toEqual([]);
  });

  it('folds the branch effects into the modifier map through content alone', () => {
    const before = commitFork(studio(), content, curves, GOLIATH);
    const fork = content.forks.find((def) => def.id === GOLIATH);
    expect(fork?.effects.length).toBeGreaterThan(0);
    expect(before?.state.forkId).toBe(GOLIATH);
  });
});
