import { describe, expect, it } from 'vitest';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { tickSlots } from './printing.js';
import {
  CHANGEOVER_BEHAVIOR,
  changeoverAutomationDefs,
  currentQueueEntry,
  isQueueRunning,
  nextQueueEntry,
  queueEntriesResolve,
  queueEntryDone,
  queueStockFloor,
} from './queue.js';

/**
 * Print queues and the auto-changeover automation (spec §5B/§5C).
 *
 * The rota only turns while the automation is installed *and* switched on —
 * friction first, then the upgrade that removes it — and it turns at the
 * natural boundary, when a batch finishes, rather than on a timer that would
 * have to interrupt a run to do anything.
 */
const content = TEST_CONTENT;
const printerId = content.start.printerId;
const object = content.objects[0];
const objectId = object?.id ?? 'bracket';
const pla = 'pla';
const petg = 'petg';
const RUN_MS = (object?.printDesignSeconds ?? 12) * 1000;
const PER_PRINT = object?.filamentGrams ?? 4;

const rota = changeoverAutomationDefs(content)[0];
if (rota === undefined) {
  throw new Error('content must ship an auto-changeover automation');
}
const ROTA = rota;

function world(over: Partial<GameState> = {}): GameState {
  return {
    ...createInitialState(content, { seed: 1 }),
    phaseId: 'farm',
    printers: { [printerId]: 1 },
    filamentGrams: { [pla]: 1000, [petg]: 1000 },
    slots: [
      testSlot({
        id: 'slot-1',
        materialId: pla,
        objectId,
        printerCount: 1,
        autoRestart: true,
        queue: [
          { materialId: pla, objectId, batches: 1 },
          { materialId: petg, objectId, batches: 1 },
        ],
      }),
    ],
    automation: {
      [ROTA.id]: { level: 1, enabled: true, threshold: ROTA.defaultThreshold, cooldownMs: 0 },
    },
    ...over,
  };
}

describe('the rota itself', () => {
  it('reads the loaded entry and the one after it, wrapping around', () => {
    const slot = world().slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    expect(currentQueueEntry(slot)?.materialId).toBe(pla);
    expect(nextQueueEntry(slot)?.materialId).toBe(petg);
    expect(nextQueueEntry({ ...slot, queueIndex: 1 })?.materialId).toBe(pla);
    /*
     * Three entries, not two. With a two-entry rota "the next one" and "the
     * previous one" are the same entry, so a rota that ran *backwards* would
     * pass every test — and one did survive here before this line existed.
     */
    const three = {
      ...slot,
      queue: [
        { materialId: pla, objectId, batches: 1 },
        { materialId: petg, objectId, batches: 1 },
        { materialId: pla, objectId: 'gearset', batches: 1 },
      ],
    };
    expect(nextQueueEntry(three)?.objectId).toBe(objectId);
    expect(nextQueueEntry({ ...three, queueIndex: 1 })?.objectId).toBe('gearset');
    expect(nextQueueEntry({ ...three, queueIndex: 2 })?.materialId).toBe(pla);
    expect(nextQueueEntry({ ...three, queueIndex: 2 })?.objectId).toBe(objectId);
    expect(nextQueueEntry({ ...slot, queue: [] })).toBeNull();
    expect(currentQueueEntry({ ...slot, queue: [] })).toBeNull();
  });

  it('knows when an entry has printed its share', () => {
    const slot = world().slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    expect(queueEntryDone(slot)).toBe(false);
    expect(queueEntryDone({ ...slot, queueBatches: 1 })).toBe(true);
    // A malformed entry asking for no batches rotates rather than jamming.
    expect(queueEntryDone({ ...slot, queue: [{ materialId: pla, objectId, batches: 0 }] })).toBe(
      false,
    );
    expect(
      queueEntryDone({
        ...slot,
        queueBatches: 1,
        queue: [{ materialId: pla, objectId, batches: 0 }],
      }),
    ).toBe(true);
    expect(queueEntryDone({ ...slot, queue: [] })).toBe(false);
  });

  it('only names materials and objects that exist', () => {
    expect(queueEntriesResolve(content, [{ materialId: pla, objectId, batches: 1 }])).toBe(true);
    expect(queueEntriesResolve(content, [{ materialId: 'ghost', objectId, batches: 1 }])).toBe(
      false,
    );
    expect(queueEntriesResolve(content, [{ materialId: pla, objectId: 'ghost', batches: 1 }])).toBe(
      false,
    );
  });

  it('runs only while the automation is installed and switched on', () => {
    expect(isQueueRunning(world(), content)).toBe(true);
    expect(isQueueRunning(world({ automation: {} }), content)).toBe(false);
    const off = world({
      automation: { [ROTA.id]: { level: 1, enabled: false, threshold: 0, cooldownMs: 0 } },
    });
    expect(isQueueRunning(off, content)).toBe(false);
  });

  it('is not turned by some other automation the player happens to own', () => {
    const other = content.automation.find((def) => def.behavior !== CHANGEOVER_BEHAVIOR);
    if (other === undefined) {
      throw new Error('content must ship more than one automation behaviour');
    }
    const elsewhere = world({
      automation: { [other.id]: { level: 1, enabled: true, threshold: 9, cooldownMs: 0 } },
    });
    expect(changeoverAutomationDefs(content).map((def) => def.id)).toEqual([ROTA.id]);
    expect(isQueueRunning(elsewhere, content)).toBe(false);
    // …and its threshold is not mistaken for the rota's stock floor either.
    expect(queueStockFloor(elsewhere, content)).toBe(0);
  });

  it('reports the stock floor of whatever rota units are installed', () => {
    expect(queueStockFloor(world(), content)).toBe(ROTA.defaultThreshold);
    expect(queueStockFloor(world({ automation: {} }), content)).toBe(0);
  });
});

describe('the print loop turning the rota (spec §5B)', () => {
  /** Advance far enough for one batch to finish and the loop to react. */
  const runOneBatch = (state: GameState): GameState => tickSlots(state, content, RUN_MS, undefined);

  it('rotates to the next entry once the current one has printed its batches', () => {
    const after = runOneBatch({
      ...world(),
      slots: world().slots.map((slot) => ({
        ...slot,
        run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
      })),
    });
    expect(after.slots[0]?.queueIndex).toBe(1);
    expect(after.slots[0]?.materialId).toBe(petg);
    // Rotating is a real changeover: the bay purges before it prints again.
    expect(after.slots[0]?.changeoverMs).toBeGreaterThan(0);
    expect(after.slots[0]?.queueBatches).toBe(0);
  });

  it('announces the switch the way a hand-driven one is announced', () => {
    const start = {
      ...world(),
      slots: world().slots.map((slot) => ({
        ...slot,
        run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
      })),
    };
    const { events } = collectEvents((emit) => tickSlots(start, content, RUN_MS, emit));
    expect(events.some((event) => event.type === 'SLOT_CONFIGURED')).toBe(true);
  });

  it('stands still while the automation is off — the friction comes back', () => {
    const off = world({
      automation: { [ROTA.id]: { level: 1, enabled: false, threshold: 0, cooldownMs: 0 } },
    });
    const after = runOneBatch({
      ...off,
      slots: off.slots.map((slot) => ({
        ...slot,
        run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
      })),
    });
    expect(after.slots[0]?.queueIndex).toBe(0);
    expect(after.slots[0]?.materialId).toBe(pla);
  });

  it('will not purge into a material the workshop cannot feed', () => {
    const dry = world({ filamentGrams: { [pla]: 1000, [petg]: 0 } });
    const after = runOneBatch({
      ...dry,
      slots: dry.slots.map((slot) => ({
        ...slot,
        run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
      })),
    });
    expect(after.slots[0]?.materialId).toBe(pla);
    expect(after.slots[0]?.queueIndex).toBe(0);
  });

  it('holds an entry for as many batches as it asks for', () => {
    const patient = world();
    const slot = patient.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const state: GameState = {
      ...patient,
      slots: [
        {
          ...slot,
          queue: [
            { materialId: pla, objectId, batches: 3 },
            { materialId: petg, objectId, batches: 1 },
          ],
          run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
        },
      ],
    };
    const once = runOneBatch(state);
    expect(once.slots[0]?.queueIndex).toBe(0);
    expect(once.slots[0]?.queueBatches).toBe(1);
    const twice = runOneBatch(once);
    expect(twice.slots[0]?.queueIndex).toBe(0);
    const thrice = runOneBatch(twice);
    expect(thrice.slots[0]?.queueIndex).toBe(1);
  });

  /**
   * The tick that finished the batch usually overshoots it. That overshoot is
   * spent on the purge, exactly as the restart path spends it on the next run —
   * otherwise every rotation would silently swallow a fraction of a tick and
   * the loop would stop being time-additive.
   */
  it('starts the purge as far along as the batch overshot', () => {
    const overshoot = 400;
    const base = world();
    const slot = base.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const purgeMs =
      (content.materials.find((m) => m.id === petg)?.changeoverDesignSeconds ?? 0) * 1000;
    const after = tickSlots(
      {
        ...base,
        slots: [{ ...slot, run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 } }],
      },
      content,
      RUN_MS + overshoot,
      undefined,
    );
    expect(after.slots[0]?.changeoverMs).toBe(purgeMs - overshoot);
  });

  it('leaves a bay with no rota counting nothing', () => {
    const plain = world({
      slots: [
        testSlot({
          id: 'slot-1',
          materialId: pla,
          objectId,
          printerCount: 1,
          autoRestart: true,
          run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 },
        }),
      ],
    });
    const after = runOneBatch(plain);
    expect(after.slots[0]?.queueBatches).toBe(0);
    expect(after.slots[0]?.materialId).toBe(pla);
    // It keeps printing the one config it has — no purge, just the next batch.
    expect(after.slots[0]?.changeoverMs).toBe(0);
    expect(after.filamentGrams[pla]).toBe(1000 - PER_PRINT);
  });
});
