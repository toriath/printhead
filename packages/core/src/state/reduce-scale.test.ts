import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { assignedPrinters } from '../systems/fleet.js';
import { forkCost } from '../systems/forks.js';
import { countPrinters } from '../systems/requirements.js';
import { effectiveSlotCapacity } from '../systems/slots.js';
import { nextSlotCost } from '../systems/slots.js';
import { TEST_CONTENT, createSim, testSlot } from './__fixtures__/sim.js';
import { assignPrinter, buyPrinter, buySlot, chooseFork, setSlotQueue, tick } from './actions.js';
import type { GameState } from './game-state.js';

/**
 * The M4 actions through the real reducer (spec §4, §5B). These are the tests
 * that matter for the player: every one of them is a sequence of clicks, and
 * every rejection here is a button the shell must not offer.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const printerId = content.start.printerId;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
const ROTA = content.automation.find((def) => def.behavior === 'auto-changeover');
const PER_SLOT = content.start.printersPerSlot;

if (ROTA === undefined) {
  throw new Error('content must ship an auto-changeover automation');
}

/** A workshop parked in a phase, with machines, money and bays as asked. */
function farmSim(over: Partial<GameState> = {}) {
  const sim = createSim();
  sim.state = {
    ...sim.state,
    phaseId: 'farm',
    printers: { [printerId]: 1 },
    resources: { ...sim.state.resources, parts: 5000 },
    partsValue: 5000,
    filamentGrams: { ...sim.state.filamentGrams, [materialId]: 1000 },
    slots: [testSlot({ id: 'slot-1', materialId, objectId, printerCount: 1 })],
    ...over,
  };
  return sim;
}

describe('BUY_SLOT (spec §4)', () => {
  it('adds a bay, charges for it and announces it', () => {
    const sim = farmSim();
    const cost = nextSlotCost(content, curves, 'slot-2')?.amount ?? 0;
    sim.do(buySlot('slot-2'));
    expect(sim.state.slots).toHaveLength(2);
    expect(sim.state.slots[1]?.id).toBe('slot-2');
    expect(sim.state.resources.parts).toBe(5000 - cost);
    expect(sim.eventsOf('SLOT_UNLOCKED')[0]).toMatchObject({
      unlockId: 'slot-2',
      slotId: 'slot-2',
      slotCount: 2,
    });
  });

  it('is refused before its phase, out of order, and when unaffordable', () => {
    const early = createSim().do(buySlot('slot-2'));
    expect(early.state.slots).toHaveLength(1);
    expect(early.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('phase-gated');

    const skipped = farmSim().do(buySlot('slot-3'));
    expect(skipped.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('out-of-order');

    const broke = farmSim({ resources: { ...createSim().state.resources, parts: 0 } }).do(
      buySlot('slot-2'),
    );
    expect(broke.state.slots).toHaveLength(1);
    expect(broke.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('insufficient-resources');
  });

  it('stops at the hard maximum (spec §4: 1 → 2 → 3 → 4)', () => {
    const sim = farmSim({
      phaseId: 'prestige',
      upgrades: { enclosure: 1 },
      resources: { ...createSim().state.resources, parts: 1e9, plates: 1 },
      partsValue: 1e9,
    });
    for (const unlock of content.slots) {
      sim.do(buySlot(unlock.id));
    }
    expect(sim.state.slots).toHaveLength(content.start.slotCount + content.slots.length);
    sim.do(buySlot('slot-2'));
    expect(sim.state.slots).toHaveLength(4);
  });
});

describe('BUY_PRINTER and the bay ceiling', () => {
  it('refuses a machine the bay has no room for', () => {
    const sim = farmSim({
      printers: { [printerId]: PER_SLOT },
      slots: [testSlot({ id: 'slot-1', materialId, objectId, printerCount: PER_SLOT })],
    });
    sim.do(buyPrinter(printerId, 'slot-1'));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('slot-full');
    expect(countPrinters(sim.state)).toBe(PER_SLOT);
  });

  it('houses it in the bay that has room once one is bought', () => {
    const sim = farmSim({
      printers: { [printerId]: PER_SLOT },
      slots: [testSlot({ id: 'slot-1', materialId, objectId, printerCount: PER_SLOT })],
    });
    sim.do(buySlot('slot-2'), buyPrinter(printerId, 'slot-2'));
    expect(sim.state.slots[1]?.printerCount).toBe(1);
    expect(assignedPrinters(sim.state)).toBe(countPrinters(sim.state));
  });
});

describe('ASSIGN_PRINTER (spec §4)', () => {
  it('moves machines between bays and announces the move', () => {
    const sim = farmSim({
      printers: { [printerId]: 4 },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: 4 }),
        testSlot({ id: 'slot-2', materialId, objectId }),
      ],
    });
    sim.do(assignPrinter('slot-1', 'slot-2', 2));
    expect(sim.state.slots.map((slot) => slot.printerCount)).toEqual([2, 2]);
    expect(sim.eventsOf('PRINTERS_ASSIGNED')[0]).toMatchObject({
      fromSlotId: 'slot-1',
      toSlotId: 'slot-2',
      moved: 2,
    });
  });

  it('never changes how many machines exist', () => {
    const sim = farmSim({
      printers: { [printerId]: 3 },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: 3 }),
        testSlot({ id: 'slot-2', materialId, objectId }),
      ],
    });
    sim.do(assignPrinter('slot-1', 'slot-2', 99), assignPrinter('slot-2', 'slot-1', 1));
    expect(assignedPrinters(sim.state)).toBe(3);
    expect(countPrinters(sim.state)).toBe(3);
  });

  it('reports why a move it cannot make was refused', () => {
    const sim = farmSim();
    sim.do(assignPrinter('slot-1', 'ghost', 1));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('unknown-target');
  });
});

describe('SET_SLOT_QUEUE (spec §5B)', () => {
  const withRota = (over: Partial<GameState> = {}) =>
    farmSim({
      automation: {
        [ROTA.id]: { level: 1, enabled: true, threshold: ROTA.defaultThreshold, cooldownMs: 0 },
      },
      ...over,
    });

  it('writes the rota and loads its first entry', () => {
    const sim = withRota();
    sim.do(
      setSlotQueue('slot-1', [
        { materialId, objectId, batches: 2 },
        { materialId, objectId, batches: 1 },
      ]),
    );
    expect(sim.state.slots[0]?.queue).toHaveLength(2);
    expect(sim.state.slots[0]?.queueIndex).toBe(0);
    expect(sim.state.slots[0]?.materialId).toBe(materialId);
    expect(sim.eventsOf('SLOT_QUEUE_SET')[0]).toMatchObject({ slotId: 'slot-1', entries: 2 });
  });

  it('needs the auto-changeover unit — the rota is the automation, not a freebie', () => {
    const sim = farmSim();
    sim.do(setSlotQueue('slot-1', [{ materialId, objectId, batches: 1 }]));
    expect(sim.state.slots[0]?.queue).toEqual([]);
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('missing-prerequisite');
  });

  it('cannot smuggle in a material the machine tree has not opened', () => {
    const sim = withRota();
    sim.do(setSlotQueue('slot-1', [{ materialId: 'resin', objectId, batches: 1 }]));
    expect(sim.state.slots[0]?.queue).toEqual([]);
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('locked');
  });

  it('rejects unknown bays and unknown entries', () => {
    const sim = withRota();
    sim.do(setSlotQueue('ghost', []));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('unknown-target');
    sim.do(setSlotQueue('slot-1', [{ materialId: 'ghost', objectId, batches: 1 }]));
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('unknown-target');
  });

  it('clears the rota when handed an empty list', () => {
    const sim = withRota();
    sim.do(setSlotQueue('slot-1', [{ materialId, objectId, batches: 1 }]));
    sim.do(setSlotQueue('slot-1', []));
    expect(sim.state.slots[0]?.queue).toEqual([]);
  });
});

describe('CHOOSE_FORK (spec §5B)', () => {
  // The fork is priced in money since the M7 rebalance.
  const studio = (over: Partial<GameState> = {}) =>
    farmSim({
      phaseId: 'studio',
      resources: { ...createSim().state.resources, parts: 5000, money: 1_000_000 },
      // Goliath's prerequisites since the M7 rebalance.
      upgrades: { 'sintering-head': 1 },
      stats: { ...createSim().state.stats, prestigeCount: 1 },
      ...over,
    });

  it('commits the run and announces it', () => {
    const sim = studio();
    const cost = forkCost(content, curves, 'farm-path');
    if (cost === null || cost.resource === 'filament') {
      throw new Error('expected the fork to cost a resource');
    }
    const before = sim.state.resources[cost.resource];
    sim.do(chooseFork('farm-path'));
    expect(sim.state.forkId).toBe('farm-path');
    expect(sim.state.resources[cost.resource]).toBe(before - cost.amount);
    expect(sim.eventsOf('FORK_CHOSEN')[0]).toMatchObject({ forkId: 'farm-path' });
  });

  it('is exclusive: the other branch is closed forever after', () => {
    const sim = studio();
    sim.do(chooseFork('farm-path'), chooseFork('goliath'));
    expect(sim.state.forkId).toBe('farm-path');
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('max-level');
  });

  it('melts the rack into one machine on the Goliath branch', () => {
    const sim = studio({
      printers: { [printerId]: 5 },
      slots: [
        testSlot({ id: 'slot-1', materialId, objectId, printerCount: 3 }),
        testSlot({ id: 'slot-2', materialId, objectId, printerCount: 2 }),
      ],
    });
    sim.do(chooseFork('goliath'));
    expect(sim.state.slots[0]?.printerCount).toBe(5);
    expect(sim.state.slots[1]?.printerCount).toBe(0);
    expect(effectiveSlotCapacity(sim.state, content)).toBe(1);
    expect(assignedPrinters(sim.state)).toBe(countPrinters(sim.state));
  });

  it('changes the pace of a run through the modifier map, not a special case', () => {
    const running = () =>
      studio({
        slots: [
          testSlot({ id: 'slot-1', materialId, objectId, printerCount: 1, autoRestart: true }),
        ],
      });
    const before = running().do(tick(100));
    const plain = before.state.slots[0]?.run;
    const after = running().do(chooseFork('goliath'), tick(100));
    const forked = after.state.slots[0]?.run;
    expect(plain?.totalMs).toBeGreaterThan(0);
    // Goliath is the slow, enormous machine: the same batch takes it longer.
    expect(forked?.totalMs).toBeGreaterThan(plain?.totalMs ?? 0);
  });

  it('is refused before its phase and when unaffordable', () => {
    const early = farmSim().do(chooseFork('farm-path'));
    expect(early.state.forkId).toBeNull();
    expect(early.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('phase-gated');

    const broke = studio({
      resources: { ...createSim().state.resources, parts: 0 },
      partsValue: 0,
    });
    broke.do(chooseFork('farm-path'));
    expect(broke.state.forkId).toBeNull();
    expect(broke.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('insufficient-resources');
  });
});
