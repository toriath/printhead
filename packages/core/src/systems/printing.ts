import { indexById } from '../content/load.js';
import type { Content, MaterialDef, ObjectDef } from '../content/schema.js';
import { MAX_RUN_COMPLETIONS_PER_TICK, MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import type { GameState, PrintRunState, SlotState } from '../state/game-state.js';
import { bankScrap, chargePerPrint, resolveBatchFailures, scrapFromFailure } from './failure.js';
import { isQueueRunning, nextQueueEntry, queueEntryDone, queueStockFloor } from './queue.js';
import { addParts, withFilament } from './resources.js';
import { type ModifierMap, computeModifiers, modifierOf } from './upgrades.js';

/**
 * The print cycle (spec §2/§4). A slot holds one `{ material, objectType }`
 * config; every printer assigned to the slot runs that config, so a run is a
 * *batch* of `printerCount` identical prints that start and finish together.
 *
 * Since M3 a batch can also *fail*: the slot carries a pity charge and a run
 * that crosses the threshold yields Scrap instead of Parts (spec §7.1). And
 * changing a slot's configuration costs time and a purge of filament (spec §3),
 * which is held on the slot as `changeoverMs`.
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

/**
 * The visible tier of the workshop's machines (spec §4/§5A): the best owned
 * printer, or better still whatever the machine tree has bolted onto it. A
 * heated bed or an enclosure changes the SVG, so it has to reach the
 * projection, and it does so as a `machineTier` upgrade effect in content.
 *
 * It is a property of the *workshop*, not of a bay, and that is deliberate:
 * machines are an undifferentiated pool the player allocates as counts (see
 * `systems/fleet.ts`), and the machine tree upgrades all of them at once. Spec
 * §4 asks a bay to show "the best machine tier among its printers", which under
 * this model is the same number for every bay. If printers ever become
 * per-slot — a bay holding *these* machines rather than *this many* — the
 * projection gains a per-slot tier and this function gains a slot argument.
 */
export function bestPrinterTier(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
): number {
  let tier = NONE;
  for (const printer of content.printers) {
    if ((state.printers[printer.id] ?? NONE) > NONE && printer.machineTier > tier) {
      tier = printer.machineTier;
    }
  }
  return tier > NONE ? Math.max(tier, modifierOf(modifiers, 'machineTier', NONE)) : NONE;
}

/** The best owned machine, sped up by the machine tree, sets the pace of a run. */
export function bestSpeedMultiplier(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
): number {
  let best = NONE;
  for (const printer of content.printers) {
    if ((state.printers[printer.id] ?? NONE) > NONE && printer.speedMultiplier > best) {
      best = printer.speedMultiplier;
    }
  }
  return best * modifierOf(modifiers, 'printSpeedMultiplier', FULL);
}

/** The gentlest failure rate among the owned fleet — you run your best machine. */
export function bestFailureChargeMultiplier(state: GameState, content: Content): number {
  let best: number | null = null;
  for (const printer of content.printers) {
    if ((state.printers[printer.id] ?? NONE) > NONE) {
      best =
        best === null
          ? printer.failureChargeMultiplier
          : Math.min(best, printer.failureChargeMultiplier);
    }
  }
  return best ?? FULL;
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

/** Parts and money value produced by the *successful* prints in a batch. */
export function batchYield(config: SlotConfig, batch: number, yieldMultiplier: number): BatchYield {
  const parts = config.object.partsYield * batch * yieldMultiplier;
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

// --- changeover (spec §3) ---------------------------------------------------

export interface Changeover {
  readonly slot: SlotState;
  readonly purgedMaterialId: string | null;
  readonly purgedGrams: number;
  readonly downtimeMs: number;
}

/**
 * Load a new configuration into an idle slot. Switching *material* costs the
 * incoming material's changeover time and purges some of the outgoing spool;
 * swapping only the object is free, because the nozzle never changes.
 */
export function applyChangeover(
  state: GameState,
  slot: SlotState,
  next: SlotConfig,
): { readonly state: GameState; readonly changeover: Changeover } {
  const switching = slot.materialId !== null && slot.materialId !== next.material.id;
  if (!switching) {
    return {
      state,
      changeover: {
        slot: { ...slot, materialId: next.material.id, objectId: next.object.id },
        purgedMaterialId: null,
        purgedGrams: NONE,
        downtimeMs: NONE,
      },
    };
  }
  const outgoingId = slot.materialId;
  const stock = state.filamentGrams[outgoingId] ?? NONE;
  const purged = Math.min(stock, next.material.changeoverWasteGrams);
  const downtimeMs = next.material.changeoverDesignSeconds * MS_PER_SECOND;
  return {
    state: { ...state, filamentGrams: withFilament(state.filamentGrams, outgoingId, -purged) },
    changeover: {
      slot: {
        ...slot,
        materialId: next.material.id,
        objectId: next.object.id,
        changeoverMs: downtimeMs,
        // A fresh nozzle is a fresh pity timer: the charge belongs to the
        // material that built it up, not to the slot forever.
        failureCharge: NONE,
      },
      purgedMaterialId: outgoingId,
      purgedGrams: purged,
      downtimeMs,
    },
  };
}

// --- the run loop -----------------------------------------------------------

export type StartRejection = 'unknown-target' | 'slot-busy' | 'insufficient-resources';

/**
 * Load a slot's printers with filament and start a batch. Returns `null` when
 * the slot cannot run — unconfigured, already busy, mid-changeover, no
 * printers, no filament.
 */
export function beginRun(
  state: GameState,
  content: Content,
  index: number,
  carryMs: number,
  emit: EventSink | undefined,
  modifiers: ModifierMap = computeModifiers(state, content),
): GameState | null {
  const slot = state.slots.at(index);
  if (slot === undefined || slot.run !== null || slot.changeoverMs > NONE) {
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
  const speed = bestSpeedMultiplier(state, content, modifiers);
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
  modifiers: ModifierMap,
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

  const perPrint = chargePerPrint(
    config.material,
    bestFailureChargeMultiplier(state, content),
    modifiers,
  );
  const outcome = resolveBatchFailures(content.failure, slot.failureCharge, run.batch, perPrint);
  const produced = batchYield(
    config,
    outcome.succeeded,
    modifierOf(modifiers, 'partsYieldMultiplier', FULL),
  );
  const scrapped = scrapFromFailure(config.material, config.object.filamentGrams * outcome.failed);

  const banked = bankScrap(addParts(state, produced.parts, produced.value), scrapped);
  const counted: GameState = {
    ...banked,
    stats: {
      ...banked.stats,
      printsCompleted: banked.stats.printsCompleted + outcome.succeeded,
      printsFailed: banked.stats.printsFailed + outcome.failed,
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
    failed: outcome.failed,
    scrapGrams: scrapped.grams,
  });
  if (outcome.failed > NONE) {
    emit?.({
      type: 'PRINT_FAILED',
      simTimeMs: state.simTimeMs,
      slotId: slot.id,
      materialId: config.material.id,
      failed: outcome.failed,
      scrapGrams: scrapped.grams,
    });
  }
  const idle = withSlot(counted, index, {
    ...slot,
    run: null,
    failureCharge: outcome.charge,
    // Only a bay with a rota counts batches against it; a bay printing one
    // config forever would otherwise carry a meaningless ever-growing number
    // into every save.
    queueBatches: slot.queue.length > NONE ? slot.queueBatches + FULL : NONE,
  });
  const rotated = rotateQueue(idle, content, index, emit);
  if (rotated !== null) {
    // The bay is now purging for the next entry on the rota; the restart
    // happens on the far side of the changeover, through the same idle path a
    // stalled slot takes.
    return rotated;
  }
  if (!slot.autoRestart) {
    return idle;
  }
  return beginRun(idle, content, index, run.remainingMs, emit, modifiers) ?? idle;
}

/**
 * Turn the slot's rota by one entry (spec §5B), or `null` when it should not
 * turn: no rota, the automation missing or switched off, the current entry
 * still owed batches, or not enough of the incoming material to be worth the
 * purge. Rotation goes through `applyChangeover`, so a queued switch costs the
 * player exactly what a hand-driven one does (spec §3).
 */
function rotateQueue(
  state: GameState,
  content: Content,
  index: number,
  emit: EventSink | undefined,
): GameState | null {
  const slot = state.slots.at(index);
  if (slot === undefined || !queueEntryDone(slot) || !isQueueRunning(state, content)) {
    return null;
  }
  const entry = nextQueueEntry(slot);
  if (entry === null) {
    return null;
  }
  const config = resolveSlotConfig(content, {
    ...slot,
    materialId: entry.materialId,
    objectId: entry.objectId,
  });
  if (config === null) {
    return null;
  }
  const stock = state.filamentGrams[config.material.id] ?? NONE;
  if (config.material.id !== slot.materialId && stock < queueStockFloor(state, content)) {
    return null;
  }
  const { state: purged, changeover } = applyChangeover(state, slot, config);
  emit?.({
    type: 'SLOT_CONFIGURED',
    simTimeMs: state.simTimeMs,
    slotId: slot.id,
    materialId: config.material.id,
    objectId: config.object.id,
    downtimeMs: changeover.downtimeMs,
    purgedGrams: changeover.purgedGrams,
    abandonedBatch: NONE,
  });
  return withSlot(purged, index, {
    ...changeover.slot,
    autoRestart: true,
    queueIndex: (slot.queueIndex + FULL) % slot.queue.length,
    queueBatches: NONE,
  });
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
  modifiers: ModifierMap = computeModifiers(state, content),
): GameState {
  let next = state;
  for (let index = NONE; index < next.slots.length; index += FULL) {
    next = tickSlot(next, content, index, dtMs, emit, modifiers);
  }
  return next;
}

/**
 * Burn `dtMs` off a slot's changeover purge. Any overshoot is handed back as a
 * negative carry so the run that follows starts that much further along — the
 * same trick the run loop uses, and for the same reason: no tick may be lost.
 */
function tickChangeover(
  state: GameState,
  index: number,
  dtMs: number,
  emit: EventSink | undefined,
): { readonly state: GameState; readonly remainingDtMs: number; readonly blocked: boolean } {
  const slot = state.slots.at(index);
  if (slot === undefined || slot.changeoverMs <= NONE) {
    return { state, remainingDtMs: dtMs, blocked: false };
  }
  if (slot.changeoverMs > dtMs) {
    return {
      state: withSlot(state, index, { ...slot, changeoverMs: slot.changeoverMs - dtMs }),
      remainingDtMs: NONE,
      blocked: true,
    };
  }
  emit?.({ type: 'CHANGEOVER_COMPLETED', simTimeMs: state.simTimeMs, slotId: slot.id });
  return {
    state: withSlot(state, index, { ...slot, changeoverMs: NONE }),
    remainingDtMs: dtMs - slot.changeoverMs,
    blocked: false,
  };
}

function tickSlot(
  state: GameState,
  content: Content,
  index: number,
  dtMs: number,
  emit: EventSink | undefined,
  modifiers: ModifierMap,
): GameState {
  const purge = tickChangeover(state, index, dtMs, emit);
  let next = purge.state;
  if (purge.blocked) {
    return next;
  }
  // Whatever the purge did not consume still has to be spent on the run, or a
  // changeover would silently swallow part of a tick.
  const remainingDt = purge.remainingDtMs;

  const idleSlot = next.slots.at(index);
  if (idleSlot !== undefined && idleSlot.run === null) {
    // An auto-restarting slot that stalled (no filament) resumes by itself.
    // The resumed run is advanced by this same tick's `dt` below, so restarting
    // costs no simulation time — otherwise every stall would silently leak one
    // tick and the loop would no longer be time-additive.
    if (!idleSlot.autoRestart) {
      return next;
    }
    const resumed = beginRun(next, content, index, NONE, emit, modifiers);
    if (resumed === null) {
      return next;
    }
    next = resumed;
  }
  const running = next.slots.at(index);
  if (running === undefined || running.run === null) {
    return next;
  }
  next = withSlot(next, index, { ...running, run: tickRun(running.run, remainingDt) });

  let completions = NONE;
  while (completions < MAX_RUN_COMPLETIONS_PER_TICK) {
    const slot = next.slots.at(index);
    if (slot === undefined || slot.run === null || !isRunComplete(slot.run)) {
      return next;
    }
    next = completeRun(next, content, index, emit, modifiers);
    completions += FULL;
  }
  return next;
}
