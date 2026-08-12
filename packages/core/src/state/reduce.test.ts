import { describe, expect, it } from 'vitest';
import { createCurveRegistry, evaluateCurveById } from '../curves/evaluate.js';
import { TICK_MS } from '../engine/constants.js';
import { createRng } from '../rng/mulberry32.js';
import { SAVE_SCHEMA_VERSION } from '../save/version.js';
import { nextPrinterCost } from '../systems/economy.js';
import {
  FIRST_MATERIAL_ID,
  FIRST_OBJECT_ID,
  FIRST_SLOT_ID,
  TEST_CONTENT,
  assemblePrinter,
  createSim,
  playUntil,
} from './__fixtures__/sim.js';
import {
  advancePhase,
  attachPiece,
  buyFilament,
  buyPrinter,
  sellParts,
  setSlotConfig,
  startPrint,
  tick,
} from './actions.js';
import { type ReduceContext, createInitialState } from './game-state.js';
import { reduce } from './reduce.js';

const content = TEST_CONTENT;
const ctx: ReduceContext = { content, nowMs: 0, rng: createRng(1) };
const initial = createInitialState(content, { seed: 1 });
const pieces = content.start.assemblyPieces;
const bracket = content.objects[0];
const ONE_HOUR_SECONDS = 3600;
const curves = createCurveRegistry(content.curves);

describe('reduce', () => {
  it('starts in the first content phase with the starting kit from content', () => {
    expect(initial.phaseId).toBe('intro');
    expect(initial.simTimeMs).toBe(0);
    expect(initial.tickCount).toBe(0);
    expect(initial.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(initial.resources).toEqual(content.start.startingResources);
    expect(initial.filamentGrams[FIRST_MATERIAL_ID]).toBe(content.start.startingFilament[0]?.grams);
    expect(initial.slots).toHaveLength(content.start.slotCount);
    expect(initial.printers).toEqual({});
    expect(initial.assembly).toEqual({
      attachedPieceIds: [],
      cooldownMs: (pieces[0]?.attachDesignSeconds ?? 0) * 1000,
    });
  });

  it('advances sim time and tick count on TICK', () => {
    const next = reduce(initial, tick(TICK_MS), ctx);
    expect(next.simTimeMs).toBe(TICK_MS);
    expect(next.tickCount).toBe(1);
  });

  it('is pure — the input state is never mutated', () => {
    const before = JSON.stringify(initial);
    reduce(initial, tick(TICK_MS), ctx);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('is deterministic for the same (state, action, ctx)', () => {
    expect(reduce(initial, tick(TICK_MS), ctx)).toEqual(reduce(initial, tick(TICK_MS), ctx));
  });

  it('rejects negative or non-finite timesteps', () => {
    expect(() => reduce(initial, tick(-1), ctx)).toThrow(RangeError);
    expect(() => reduce(initial, tick(Number.NaN), ctx)).toThrow(RangeError);
  });
});

describe('phase gating', () => {
  it('refuses actions the current phase does not allow', () => {
    const sim = createSim().do(buyPrinter('bench-mk1', FIRST_SLOT_ID));
    expect(sim.state.printers).toEqual({});
    expect(sim.eventsOf('ACTION_REJECTED')[0]).toMatchObject({
      actionType: 'BUY_PRINTER',
      reason: 'phase-gated',
    });
  });

  it('never gates TICK or ADVANCE_PHASE', () => {
    const sim = createSim().do(tick(TICK_MS), advancePhase());
    expect(sim.state.tickCount).toBe(1);
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.actionType)).toEqual([
      'ADVANCE_PHASE',
    ]);
  });

  it('refuses to advance while the phase requirements are unmet', () => {
    const sim = createSim().do(advancePhase());
    expect(sim.state.phaseId).toBe('intro');
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('not-ready');
  });
});

describe('intro assembly', () => {
  it('attaches pieces in order, one bench-work stretch at a time', () => {
    const sim = createSim();
    const first = pieces[0];
    expect(first).toBeDefined();
    sim.do(attachPiece(first?.id ?? ''));
    expect(sim.state.assembly.attachedPieceIds).toEqual([]);
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('not-ready');

    sim.tickSeconds(first?.attachDesignSeconds ?? 0);
    sim.do(attachPiece(first?.id ?? ''));
    expect(sim.state.assembly.attachedPieceIds).toEqual([first?.id]);
    expect(sim.state.assembly.cooldownMs).toBe((pieces[1]?.attachDesignSeconds ?? 0) * 1000);
  });

  it('refuses pieces out of order', () => {
    const sim = createSim().tickSeconds(600).do(attachPiece('controller'));
    expect(sim.state.assembly.attachedPieceIds).toEqual([]);
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('out-of-order');
  });

  it('builds printer #1 and assigns it to the first slot on the last click', () => {
    const sim = assemblePrinter(createSim());
    expect(sim.state.assembly.attachedPieceIds).toHaveLength(pieces.length);
    expect(sim.state.printers[content.start.printerId]).toBe(1);
    expect(sim.state.slots[0]?.printerCount).toBe(1);
    expect(sim.eventsOf('ASSEMBLY_COMPLETED')).toHaveLength(1);
    expect(sim.eventsOf('PRINTER_BUILT')[0]).toMatchObject({ owned: 1, paid: 0 });
  });

  it('ignores extra clicks once the printer is finished', () => {
    const sim = assemblePrinter(createSim()).do(attachPiece('frame'));
    expect(sim.state.printers[content.start.printerId]).toBe(1);
  });
});

describe('the print cycle', () => {
  const configured = () =>
    assemblePrinter(createSim()).do(
      setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID),
    );

  it('configures a slot and reports it', () => {
    const sim = configured();
    expect(sim.state.slots[0]).toMatchObject({
      materialId: FIRST_MATERIAL_ID,
      objectId: FIRST_OBJECT_ID,
    });
    expect(sim.eventsOf('SLOT_CONFIGURED')).toHaveLength(1);
  });

  it('rejects unknown slots, materials and objects', () => {
    const sim = configured()
      .do(setSlotConfig('slot-9', FIRST_MATERIAL_ID, FIRST_OBJECT_ID))
      .do(setSlotConfig(FIRST_SLOT_ID, 'unobtainium', FIRST_OBJECT_ID))
      .do(startPrint('slot-9'));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toEqual([
      'unknown-target',
      'unknown-target',
      'unknown-target',
    ]);
  });

  it('refuses materials whose unlock phase has not been reached', () => {
    const sim = configured().do(setSlotConfig(FIRST_SLOT_ID, 'petg', FIRST_OBJECT_ID));
    expect(sim.state.slots[0]?.materialId).toBe(FIRST_MATERIAL_ID);
    // "locked", not "unknown-target": petg exists, it is just not available yet.
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('locked');
  });

  it('refuses objects whose unlock phase has not been reached', () => {
    const sim = configured().do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, 'gearset'));
    expect(sim.state.slots[0]?.objectId).toBe(FIRST_OBJECT_ID);
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('locked');
  });

  it('consumes filament up front and yields parts when the batch finishes', () => {
    const sim = configured();
    const grams = sim.state.filamentGrams[FIRST_MATERIAL_ID] ?? 0;
    sim.do(startPrint(FIRST_SLOT_ID));
    expect(sim.state.filamentGrams[FIRST_MATERIAL_ID]).toBe(grams - (bracket?.filamentGrams ?? 0));
    expect(sim.state.resources.parts).toBe(0);

    sim.tickSeconds(bracket?.printDesignSeconds ?? 0);
    expect(sim.state.resources.parts).toBe(bracket?.partsYield);
    expect(sim.state.partsValue).toBeCloseTo(
      (bracket?.partsYield ?? 0) * (bracket?.basePartValue ?? 0),
      9,
    );
    expect(sim.eventsOf('PRINT_COMPLETED')).toHaveLength(1);
  });

  it('auto-restarts the cycle and keeps the leftover time', () => {
    const sim = configured().do(startPrint(FIRST_SLOT_ID));
    const runSeconds = bracket?.printDesignSeconds ?? 1;
    sim.tickSeconds(runSeconds * 3);
    expect(sim.state.stats.printsCompleted).toBe(3);
    expect(sim.state.slots[0]?.run).not.toBeNull();
  });

  it('stalls without filament and resumes by itself once it is bought', () => {
    const sim = configured().do(startPrint(FIRST_SLOT_ID));
    // Burn the starting spool.
    sim.tickSeconds((bracket?.printDesignSeconds ?? 1) * 20);
    expect(sim.state.filamentGrams[FIRST_MATERIAL_ID]).toBeLessThan(bracket?.filamentGrams ?? 0);
    expect(sim.state.slots[0]?.run).toBeNull();
    expect(sim.state.slots[0]?.autoRestart).toBe(true);

    const stalledPrints = sim.state.stats.printsCompleted;
    // BUY_FILAMENT only unlocks in `bench`, and the FSM steps on a TICK.
    sim.do(sellParts()).tickMs(TICK_MS);
    expect(sim.state.phaseId).toBe('bench');
    sim.do(buyFilament(FIRST_MATERIAL_ID, 100)).tickSeconds(bracket?.printDesignSeconds ?? 1);
    expect(sim.state.stats.printsCompleted).toBeGreaterThan(stalledPrints);
  });

  it('refuses a second START_PRINT while the slot is busy', () => {
    const sim = configured().do(startPrint(FIRST_SLOT_ID)).do(startPrint(FIRST_SLOT_ID));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('slot-busy');
  });

  it('refuses a changeover while the slot is busy', () => {
    const sim = configured()
      .do(startPrint(FIRST_SLOT_ID))
      .do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID));
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('slot-busy');
  });

  it('refuses to start an unconfigured or unstocked slot', () => {
    const bare = assemblePrinter(createSim()).do(startPrint(FIRST_SLOT_ID));
    expect(bare.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('insufficient-resources');
  });
});

describe('selling and buying', () => {
  /** Assembled, printing, and far enough in that the bench phase has opened. */
  const stocked = () =>
    assemblePrinter(createSim())
      .do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID))
      .do(startPrint(FIRST_SLOT_ID))
      .tickSeconds((bracket?.printDesignSeconds ?? 1) * 3);

  it('sells parts at their banked value and books the money', () => {
    const sim = stocked();
    const parts = sim.state.resources.parts;
    const value = sim.state.partsValue;
    sim.do(sellParts(1));
    expect(sim.state.resources.parts).toBe(parts - 1);
    expect(sim.state.resources.money).toBeCloseTo(value / parts, 9);
    expect(sim.state.stats.partsSold).toBe(1);
    expect(sim.eventsOf('PART_SOLD')[0]).toMatchObject({ parts: 1 });
  });

  it('sells everything when no count is given and strands no value', () => {
    const sim = stocked();
    const value = sim.state.partsValue;
    sim.do(sellParts());
    expect(sim.state.resources.parts).toBe(0);
    expect(sim.state.partsValue).toBe(0);
    expect(sim.state.resources.money).toBeCloseTo(value, 9);
  });

  it('rejects a sale with nothing in stock', () => {
    const sim = assemblePrinter(createSim()).do(sellParts());
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('nothing-to-do');
  });

  it('buys filament with money and refuses when it is short', () => {
    const sim = stocked().do(sellParts()).tickMs(TICK_MS);
    expect(sim.state.phaseId).toBe('bench');
    const money = sim.state.resources.money;
    const grams = sim.state.filamentGrams[FIRST_MATERIAL_ID] ?? 0;
    sim.do(buyFilament(FIRST_MATERIAL_ID, 10));
    expect(sim.state.filamentGrams[FIRST_MATERIAL_ID]).toBe(grams + 10);
    expect(sim.state.resources.money).toBeLessThan(money);

    sim.do(buyFilament(FIRST_MATERIAL_ID, 1_000_000));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toContain(
      'insufficient-resources',
    );
    sim.do(buyFilament('unobtainium', 1));
    expect(sim.eventsOf('ACTION_REJECTED').map((event) => event.reason)).toContain(
      'unknown-target',
    );
  });

  it('buys printer #2 for the curve price and assigns it to the slot', () => {
    const sim = stocked().tickMs(TICK_MS);
    // One printer is already owned, so this is the N=1 point on the cost curve.
    const price = nextPrinterCost(sim.state, content, curves, content.start.printerId);
    expect(price?.resource).toBe('parts');
    expect(price?.amount).toBe(Math.ceil(evaluateCurveById(curves, 'printer-cost-tier1', 1)));

    playUntil(sim, (s) => s.state.resources.parts >= (price?.amount ?? 0), ONE_HOUR_SECONDS);
    const parts = sim.state.resources.parts;
    sim.do(buyPrinter(content.start.printerId, FIRST_SLOT_ID));
    expect(sim.state.printers[content.start.printerId]).toBe(2);
    expect(sim.state.slots[0]?.printerCount).toBe(2);
    expect(sim.state.resources.parts).toBe(parts - (price?.amount ?? 0));
    expect(sim.eventsOf('PRINTER_BUILT').at(-1)).toMatchObject({ owned: 2 });
  });

  it('prices each printer above the last — base × growth^N (spec §5B)', () => {
    const priceAt = (owned: number) =>
      nextPrinterCost(
        { ...initial, printers: { [content.start.printerId]: owned } },
        content,
        curves,
        content.start.printerId,
      )?.amount ?? 0;
    expect(priceAt(0)).toBeLessThan(priceAt(1));
    expect(priceAt(1)).toBeLessThan(priceAt(2));
    expect(priceAt(2)).toBeLessThan(priceAt(3));
  });

  it('refuses a printer the ledger cannot pay for', () => {
    const sim = stocked()
      .do(sellParts())
      .tickMs(TICK_MS)
      .do(buyPrinter(content.start.printerId, FIRST_SLOT_ID));
    expect(sim.state.printers[content.start.printerId]).toBe(1);
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('insufficient-resources');
  });

  it('rejects an unknown printer id or slot', () => {
    const sim = stocked()
      .do(sellParts())
      .tickMs(TICK_MS)
      .do(buyPrinter('ghost-printer', FIRST_SLOT_ID))
      .do(buyPrinter(content.start.printerId, 'slot-99'));
    const reasons = sim.eventsOf('ACTION_REJECTED').map((event) => event.reason);
    expect(reasons.filter((reason) => reason === 'unknown-target')).toHaveLength(2);
  });
});

describe('the phase FSM walks itself', () => {
  it('leaves intro once the printer is built, a print is done and a part is sold', () => {
    const sim = assemblePrinter(createSim()).do(
      setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID),
      startPrint(FIRST_SLOT_ID),
    );
    expect(sim.state.phaseId).toBe('intro');
    sim.tickSeconds(bracket?.printDesignSeconds ?? 0);
    expect(sim.state.phaseId).toBe('intro');
    sim.do(sellParts(1));
    expect(sim.state.phaseId).toBe('intro');
    sim.tickMs(100);
    expect(sim.state.phaseId).toBe('bench');
    expect(sim.state.phaseEnteredAtMs).toBe(sim.state.simTimeMs);
    expect(sim.eventsOf('PHASE_ADVANCED')[0]).toMatchObject({
      fromPhaseId: 'intro',
      toPhaseId: 'bench',
    });
  });
});
