import { describe, expect, it } from 'vitest';
import type { Content } from '../content/schema.js';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, type SlotState, createInitialState } from '../state/game-state.js';
import { beginRun, tickSlots } from './printing.js';

/**
 * The slot lifecycle at the systems level. The reducer tests drive this through
 * whole games, which leaves the defensive branches — no printers, no filament,
 * a config that vanished mid-run — unreached. They are exactly the branches
 * that would fail silently in production, so they get direct tests.
 */
const content = TEST_CONTENT;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
const printerId = content.start.printerId;
const object = content.objects[0];
const RUN_MS = (object?.printDesignSeconds ?? 12) * 1000;
const PER_PRINT_GRAMS = object?.filamentGrams ?? 4;

const slot = (over: Partial<SlotState> = {}): SlotState =>
  testSlot({ materialId, objectId, printerCount: 1, ...over });

const world = (over: Partial<GameState> = {}, slotOver: Partial<SlotState> = {}): GameState => ({
  ...createInitialState(content, { seed: 1 }),
  printers: { [printerId]: 1 },
  filamentGrams: { [materialId]: 100 },
  slots: [slot(slotOver)],
  ...over,
});

const run = (state: GameState) => state.slots[0]?.run ?? null;

describe('beginRun', () => {
  it('starts a batch, consuming filament up front', () => {
    const started = beginRun(world(), content, 0, 0, undefined);
    expect(run(started as GameState)?.totalMs).toBe(RUN_MS);
    expect(started?.filamentGrams[materialId]).toBe(100 - PER_PRINT_GRAMS);
  });

  it('engages the idle loop: starting a print turns auto-restart on', () => {
    const started = beginRun(world({}, { autoRestart: false }), content, 0, 0, undefined);
    expect(started?.slots[0]?.autoRestart).toBe(true);
  });

  it('batches one print per printer assigned to the slot', () => {
    const started = beginRun(world({}, { printerCount: 3 }), content, 0, 0, undefined);
    expect(run(started as GameState)?.batch).toBe(3);
    expect(started?.filamentGrams[materialId]).toBe(100 - PER_PRINT_GRAMS * 3);
  });

  it('announces the run it started', () => {
    const { events } = collectEvents((emit) => beginRun(world(), content, 0, 0, emit));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PRINT_STARTED',
      slotId: 'slot-1',
      objectId,
      materialId,
      batch: 1,
      durationMs: RUN_MS,
    });
  });

  it('is null when the slot index does not exist', () => {
    expect(beginRun(world(), content, 9, 0, undefined)).toBeNull();
  });

  it('is null when the slot is already running', () => {
    const busy = world({}, { run: { remainingMs: 100, totalMs: RUN_MS, batch: 1 } });
    expect(beginRun(busy, content, 0, 0, undefined)).toBeNull();
  });

  it('is null when the slot has no configuration', () => {
    expect(beginRun(world({}, { materialId: null }), content, 0, 0, undefined)).toBeNull();
  });

  it('is null when the slot has no printers assigned', () => {
    expect(beginRun(world({}, { printerCount: 0 }), content, 0, 0, undefined)).toBeNull();
  });

  it('is null when there is not enough filament for even one print', () => {
    const dry = world({ filamentGrams: { [materialId]: PER_PRINT_GRAMS - 1 } });
    expect(beginRun(dry, content, 0, 0, undefined)).toBeNull();
  });

  /**
   * A slot can hold printers that no longer exist in content — a save from a
   * build where the def was removed. Without a machine there is no speed, and
   * dividing by it would produce an Infinity-length run rather than a refusal.
   */
  it('is null when nothing owned provides a print speed', () => {
    expect(beginRun(world({ printers: {} }), content, 0, 0, undefined)).toBeNull();
  });
});

describe('tickSlots', () => {
  const running = (over: Partial<SlotState> = {}) =>
    beginRun(world({}, over), content, 0, 0, undefined) as GameState;

  it('does nothing to an idle slot that is not set to auto-restart', () => {
    const idle = world({}, { autoRestart: false });
    expect(tickSlots(idle, content, 100, undefined)).toBe(idle);
  });

  it('resumes an auto-restarting slot that stalled, and advances it the same tick', () => {
    const stalled = world({}, { autoRestart: true });
    const next = tickSlots(stalled, content, 100, undefined);
    // Started *and* ticked: restarting must not silently cost a tick.
    expect(next.slots[0]?.run?.remainingMs).toBe(RUN_MS - 100);
  });

  it('leaves an auto-restarting slot alone when it still cannot run', () => {
    const dry = world({ filamentGrams: { [materialId]: 0 } }, { autoRestart: true });
    expect(tickSlots(dry, content, 100, undefined)).toBe(dry);
  });

  /**
   * A loaded save may hold a run with auto-restart off — the reducer itself
   * always engages the loop (see below), so this state only arrives from disk.
   */
  const loadedMidRun = (): GameState =>
    world({}, { autoRestart: false, run: { remainingMs: RUN_MS, totalMs: RUN_MS, batch: 1 } });

  it('completes a finished run into parts and stops when not auto-restarting', () => {
    const done = tickSlots(loadedMidRun(), content, RUN_MS, undefined);
    expect(done.resources.parts).toBe(object?.partsYield);
    expect(done.stats.printsCompleted).toBe(1);
    expect(done.slots[0]?.run).toBeNull();
  });

  it('immediately loads the next batch when auto-restarting', () => {
    const state = running({ autoRestart: true });
    const done = tickSlots(state, content, RUN_MS, undefined);
    expect(done.slots[0]?.run).not.toBeNull();
    expect(done.slots[0]?.run?.remainingMs).toBe(RUN_MS);
  });

  it('carries overshoot into the next run so no design time is lost', () => {
    const state = running({ autoRestart: true });
    const done = tickSlots(state, content, RUN_MS + 250, undefined);
    expect(done.slots[0]?.run?.remainingMs).toBe(RUN_MS - 250);
  });

  it('closes several runs in one oversized tick', () => {
    const state = running({ autoRestart: true });
    const done = tickSlots(state, content, RUN_MS * 3, undefined);
    expect(done.stats.printsCompleted).toBe(3);
  });

  /**
   * The slot's material was removed from content while a run was in flight
   * (a save from an older build). The run cannot be paid out, so it is
   * discarded rather than yielding parts from a def that no longer exists.
   */
  it('drops a run whose configuration no longer resolves', () => {
    const started = running({ autoRestart: true });
    const orphaned: GameState = {
      ...started,
      slots: started.slots.map((s) => ({ ...s, objectId: 'deleted-object' })),
    };
    const done = tickSlots(orphaned, content, RUN_MS, undefined);
    expect(done.slots[0]?.run).toBeNull();
    expect(done.resources.parts).toBe(0);
    expect(done.stats.printsCompleted).toBe(0);
  });

  it('advances every slot, not just the first', () => {
    const two: GameState = {
      ...world(),
      printers: { [printerId]: 2 },
      slots: [slot({ id: 'slot-1' }), slot({ id: 'slot-2' })],
    };
    const both = beginRun(
      beginRun(two, content, 0, 0, undefined) as GameState,
      content,
      1,
      0,
      undefined,
    ) as GameState;
    const next = tickSlots(both, content, 100, undefined);
    expect(next.slots[0]?.run?.remainingMs).toBe(RUN_MS - 100);
    expect(next.slots[1]?.run?.remainingMs).toBe(RUN_MS - 100);
  });

  it('announces completion with the batch and its yield', () => {
    const state = loadedMidRun();
    const { events } = collectEvents((emit) => tickSlots(state, content, RUN_MS, emit));
    expect(events.filter((event) => event.type === 'PRINT_COMPLETED')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'PRINT_COMPLETED',
      slotId: 'slot-1',
      batch: 1,
      parts: object?.partsYield,
    });
  });

  it('stops printing when the filament runs out mid-loop', () => {
    const limited: Content = content;
    const state = beginRun(
      world({ filamentGrams: { [materialId]: PER_PRINT_GRAMS * 2 } }, { autoRestart: true }),
      limited,
      0,
      0,
      undefined,
    ) as GameState;
    const done = tickSlots(state, limited, RUN_MS * 5, undefined);
    expect(done.stats.printsCompleted).toBe(2);
    expect(done.filamentGrams[materialId]).toBe(0);
    expect(done.slots[0]?.run).toBeNull();
  });
});
