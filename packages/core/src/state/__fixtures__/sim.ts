import { loadContent } from '../../content/load.js';
import { RAW_CONTENT } from '../../content/raw.js';
import type { Content } from '../../content/schema.js';
import { TICK_MS } from '../../engine/constants.js';
import { createEventBus } from '../../events/bus.js';
import type { DomainEvent, DomainEventType } from '../../events/types.js';
import { restoreRng } from '../../rng/mulberry32.js';
import { resolveSlotConfig } from '../../systems/printing.js';
import type { Action } from '../actions.js';
import { tick } from '../actions.js';
import {
  type GameState,
  type ReduceContext,
  type SlotState,
  createInitialState,
} from '../game-state.js';
import { reduce } from '../reduce.js';

/**
 * Test driver: a real reducer loop with a real event bus, so tests exercise
 * exactly the code path the app and the balance harness use.
 */
export const TEST_CONTENT: Content = loadContent(RAW_CONTENT);

/**
 * An empty slot with every field filled in. Tests build slots constantly, and
 * spelling the defaults out in each of them means a new `SlotState` field is a
 * hundred-line diff instead of a one-line one.
 */
export function testSlot(over: Partial<SlotState> = {}): SlotState {
  return {
    id: 'slot-1',
    materialId: null,
    objectId: null,
    designId: null,
    printerCount: 0,
    autoRestart: false,
    run: null,
    failureCharge: 0,
    changeoverMs: 0,
    queue: [],
    queueIndex: 0,
    queueBatches: 0,
    perfectCharge: 0,
    overclockMs: 0,
    overclockCooldownMs: 0,
    ...over,
  };
}

export interface Sim {
  state: GameState;
  readonly content: Content;
  do(...actions: readonly Action[]): Sim;
  /** Advance design time in whole 100 ms ticks. */
  tickMs(ms: number): Sim;
  tickSeconds(seconds: number): Sim;
  events(): readonly DomainEvent[];
  drain(): readonly DomainEvent[];
  eventsOf<T extends DomainEventType>(type: T): readonly Extract<DomainEvent, { type: T }>[];
}

export function createSim(content: Content = TEST_CONTENT, seed = 1): Sim {
  const bus = createEventBus();
  const collected: DomainEvent[] = [];
  bus.subscribe((event) => collected.push(event));

  const sim: Sim = {
    state: createInitialState(content, { seed }),
    content,
    do(...actions) {
      for (const action of actions) {
        const ctx: ReduceContext = {
          content,
          nowMs: sim.state.simTimeMs,
          rng: restoreRng(sim.state.rng),
          emit: bus.emit,
        };
        sim.state = reduce(sim.state, action, ctx);
      }
      return sim;
    },
    tickMs(ms) {
      const ticks = Math.round(ms / TICK_MS);
      for (let i = 0; i < ticks; i += 1) {
        sim.do(tick(TICK_MS));
      }
      return sim;
    },
    tickSeconds(seconds) {
      return sim.tickMs(seconds * 1000);
    },
    events: () => collected,
    drain: () => bus.drain(),
    eventsOf: (type) =>
      collected.filter((event) => event.type === type) as Extract<
        DomainEvent,
        { type: typeof type }
      >[],
  };
  return sim;
}

/** Click through the whole intro assembly, waiting out each piece's bench work. */
export function assemblePrinter(sim: Sim): Sim {
  for (const piece of sim.content.start.assemblyPieces) {
    sim.tickSeconds(piece.attachDesignSeconds);
    sim.do({ type: 'ATTACH_PIECE', pieceId: piece.id });
  }
  return sim;
}

/**
 * A `SlotConfig` for a stock object, built the way the sim builds it, so tests
 * cannot drift from the real shape of a loaded bay.
 */
export function testConfig(materialId: string, objectId: string, content: Content = TEST_CONTENT) {
  const config = resolveSlotConfig(content, testSlot({ materialId, objectId }));
  if (config === null) {
    throw new Error(`no such recipe: ${materialId}/${objectId}`);
  }
  return config;
}

export const FIRST_SLOT_ID = `${TEST_CONTENT.start.slotIdPrefix}-1`;
export const FIRST_MATERIAL_ID = TEST_CONTENT.materials[0]?.id ?? 'pla';
export const FIRST_OBJECT_ID = TEST_CONTENT.objects[0]?.id ?? 'bracket';

const RESTOCK_SLICE_SECONDS = 5;

/**
 * Tick forward while keeping the printer fed and the parts sold, until `done`
 * holds. Always bounded: a test that can never converge fails loudly instead of
 * hanging the suite. This mirrors what the `greedy-spender` bot does, so tests
 * and the balance harness stress the same loop.
 */
export function playUntil(sim: Sim, done: (sim: Sim) => boolean, limitDesignSeconds: number): Sim {
  const material = sim.content.materials.find((candidate) => candidate.id === FIRST_MATERIAL_ID);
  const deadlineMs = sim.state.simTimeMs + limitDesignSeconds * 1000;
  while (!done(sim)) {
    if (sim.state.simTimeMs >= deadlineMs) {
      throw new Error(`playUntil gave up after ${limitDesignSeconds} design-seconds`);
    }
    // Restock whenever the slot has stalled and there is money to fix it.
    const stalled = sim.state.slots[0]?.run === null;
    const perPrint = sim.content.objects.find((o) => o.id === FIRST_OBJECT_ID)?.filamentGrams ?? 1;
    const stock = sim.state.filamentGrams[FIRST_MATERIAL_ID] ?? 0;
    if (stalled && stock < perPrint) {
      sim.do({ type: 'SELL_PARTS', count: null });
      const grams = Math.floor(sim.state.resources.money / (material?.costPerGram ?? 1));
      if (grams >= perPrint) {
        sim.do({ type: 'BUY_FILAMENT', materialId: FIRST_MATERIAL_ID, grams });
      }
    }
    sim.tickSeconds(RESTOCK_SLICE_SECONDS);
  }
  return sim;
}
