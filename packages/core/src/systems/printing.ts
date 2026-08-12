import { indexById } from '../content/load.js';
import type { Content, MaterialDef, ObjectDef, PrinterDef } from '../content/schema.js';
import { MAX_RUN_COMPLETIONS_PER_TICK, MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import type { GameState, PrintRunState, SlotState } from '../state/game-state.js';
import { addParts, withFilament } from './resources.js';

/**
 * The print cycle (spec §2/§4). A slot holds one `{ material, objectType }`
 * config; every printer assigned to the slot runs that config, so a run is a
 * *batch* of `printerCount` identical prints that start and finish together.
 *
 * Every number here comes from `content/`: object print seconds, material and
 * printer speed multipliers, filament grams, part yield and part value.
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const FULL = 1;

export interface SlotConfig {
  readonly material: MaterialDef;
  readonly object: ObjectDef;
}

export function resolveSlotConfig(content: Content, slot: SlotState): SlotConfig | null {
  if (slot.materialId === null || slot.objectId === null) {
    return null;
  }
  const material = indexById(content.materials).get(slot.materialId);
  const object = indexById(content.objects).get(slot.objectId);
  if (material === undefined || object === undefined) {
    return null;
  }
  return { material, object };
}

export function printerDefOf(content: Content, printerId: string): PrinterDef | undefined {
  return indexById(content.printers).get(printerId);
}

/** The best machine among the owned printers decides the visual tier (spec §4). */
export function bestPrinterTier(state: GameState, content: Content): number {
  let tier = NONE;
  for (const printer of content.printers) {
    if ((state.printers[printer.id] ?? NONE) > NONE && printer.machineTier > tier) {
      tier = printer.machineTier;
    }
  }
  return tier;
}

/** The best owned machine also sets the pace of a run in M1's single-slot fleet. */
export function bestSpeedMultiplier(state: GameState, content: Content): number {
  let best = NONE;
  for (const printer of content.printers) {
    if ((state.printers[printer.id] ?? NONE) > NONE && printer.speedMultiplier > best) {
      best = printer.speedMultiplier;
    }
  }
  return best;
}

/**
 * How long one batch takes, in design-milliseconds. Content authors seconds;
 * the running clock is milliseconds so it decrements by whole ticks exactly.
 */
export function runDesignMs(config: SlotConfig, speedMultiplier: number): number {
  const speed = config.material.printSpeedMultiplier * speedMultiplier;
  if (speed <= NONE) {
    throw new RangeError(`print speed must be positive, received ${speed}`);
  }
  return (config.object.printDesignSeconds * MS_PER_SECOND) / speed;
}

export function filamentPerBatch(config: SlotConfig, batch: number): number {
  return config.object.filamentGrams * batch;
}

/** How many of a slot's printers the filament in stock can actually feed. */
export function affordableBatch(config: SlotConfig, printerCount: number, grams: number): number {
  const perPrint = config.object.filamentGrams;
  if (perPrint <= NONE) {
    throw new RangeError(`object "${config.object.id}" must consume filament`);
  }
  return Math.min(printerCount, Math.floor(grams / perPrint));
}

export interface BatchYield {
  readonly parts: number;
  readonly value: number;
}

/** Parts and money value produced by one completed batch (spec §2). */
export function batchYield(config: SlotConfig, batch: number): BatchYield {
  const parts = config.object.partsYield * batch;
  return {
    parts,
    value: parts * config.object.basePartValue * config.material.valueMultiplier,
  };
}

/**
 * `carryMs` is the (non-positive) overshoot of the run that just finished.
 * Rolling it into the next run keeps the loop exactly time-additive, which is
 * what makes `offline(2t) ≡ offline(t) ∘ offline(t)` hold to the millisecond.
 */
export function startRun(
  config: SlotConfig,
  batch: number,
  speedMultiplier: number,
  carryMs: number,
): PrintRunState {
  const totalMs = runDesignMs(config, speedMultiplier);
  return { remainingMs: totalMs + carryMs, totalMs, batch };
}

export function tickRun(run: PrintRunState, dtMs: number): PrintRunState {
  return { ...run, remainingMs: run.remainingMs - dtMs };
}

export function isRunComplete(run: PrintRunState): boolean {
  return run.remainingMs <= NONE;
}

/** 0..1 for the renderer; a finished run reads as fully printed. */
export function runProgress(run: PrintRunState): number {
  if (run.totalMs <= NONE) {
    return FULL;
  }
  const done = (run.totalMs - run.remainingMs) / run.totalMs;
  return Math.min(Math.max(done, NONE), FULL);
}

export function withSlot(state: GameState, index: number, slot: SlotState): GameState {
  return { ...state, slots: state.slots.map((current, i) => (i === index ? slot : current)) };
}

export function slotIndexOf(state: GameState, slotId: string): number {
  return state.slots.findIndex((slot) => slot.id === slotId);
}

export type StartRejection = 'unknown-target' | 'slot-busy' | 'insufficient-resources';

/**
 * Load a slot's printers with filament and start a batch. Returns `null` when
 * the slot cannot run — unconfigured, already busy, no printers, no filament.
 */
export function beginRun(
  state: GameState,
  content: Content,
  index: number,
  carryMs: number,
  emit: EventSink | undefined,
): GameState | null {
  const slot = state.slots.at(index);
  if (slot === undefined || slot.run !== null) {
    return null;
  }
  const config = resolveSlotConfig(content, slot);
  if (config === null || slot.printerCount <= NONE) {
    return null;
  }
  const stock = state.filamentGrams[config.material.id] ?? NONE;
  const batch = affordableBatch(config, slot.printerCount, stock);
  if (batch <= NONE) {
    return null;
  }
  const speed = bestSpeedMultiplier(state, content);
  if (speed <= NONE) {
    return null;
  }
  const run = startRun(config, batch, speed, carryMs);
  const withStock: GameState = {
    ...state,
    filamentGrams: withFilament(
      state.filamentGrams,
      config.material.id,
      -filamentPerBatch(config, batch),
    ),
  };
  emit?.({
    type: 'PRINT_STARTED',
    simTimeMs: state.simTimeMs,
    slotId: slot.id,
    objectId: config.object.id,
    materialId: config.material.id,
    batch,
    durationMs: run.totalMs,
  });
  return withSlot(withStock, index, { ...slot, autoRestart: true, run });
}

function completeRun(
  state: GameState,
  content: Content,
  index: number,
  emit: EventSink | undefined,
): GameState {
  const slot = state.slots.at(index);
  const run = slot?.run;
  if (slot === undefined || run === undefined || run === null) {
    return state;
  }
  const config = resolveSlotConfig(content, slot);
  if (config === null) {
    return withSlot(state, index, { ...slot, run: null });
  }
  const produced = batchYield(config, run.batch);
  const banked = addParts(state, produced.parts, produced.value);
  const counted: GameState = {
    ...banked,
    stats: {
      ...banked.stats,
      printsCompleted: banked.stats.printsCompleted + run.batch,
      partsProduced: banked.stats.partsProduced + produced.parts,
    },
  };
  emit?.({
    type: 'PRINT_COMPLETED',
    simTimeMs: state.simTimeMs,
    slotId: slot.id,
    objectId: config.object.id,
    materialId: config.material.id,
    batch: run.batch,
    parts: produced.parts,
    partsValue: produced.value,
  });
  const idle = withSlot(counted, index, { ...slot, run: null });
  if (!slot.autoRestart) {
    return idle;
  }
  return beginRun(idle, content, index, run.remainingMs, emit) ?? idle;
}

/**
 * Advance every slot by `dtMs`, closing out finished batches and — when
 * the slot is set to auto-restart — immediately loading the next one.
 */
export function tickSlots(
  state: GameState,
  content: Content,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  let next = state;
  for (let index = NONE; index < next.slots.length; index += FULL) {
    next = tickSlot(next, content, index, dtMs, emit);
  }
  return next;
}

function tickSlot(
  state: GameState,
  content: Content,
  index: number,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  let next = state;
  const idleSlot = next.slots.at(index);
  if (idleSlot !== undefined && idleSlot.run === null) {
    // An auto-restarting slot that stalled (no filament) resumes by itself.
    // The resumed run is advanced by this same tick's `dt` below, so restarting
    // costs no simulation time — otherwise every stall would silently leak one
    // tick and the loop would no longer be time-additive.
    if (!idleSlot.autoRestart) {
      return next;
    }
    const resumed = beginRun(next, content, index, NONE, emit);
    if (resumed === null) {
      return next;
    }
    next = resumed;
  }
  const running = next.slots.at(index);
  if (running === undefined || running.run === null) {
    return next;
  }
  next = withSlot(next, index, { ...running, run: tickRun(running.run, dtMs) });

  let completions = NONE;
  while (completions < MAX_RUN_COMPLETIONS_PER_TICK) {
    const slot = next.slots.at(index);
    if (slot === undefined || slot.run === null || !isRunComplete(slot.run)) {
      return next;
    }
    next = completeRun(next, content, index, emit);
    completions += FULL;
  }
  return next;
}
