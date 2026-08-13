import { indexById } from '../content/load.js';
import type { Content, DesignDef, MaterialDef, ObjectDef } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MAX_RUN_COMPLETIONS_PER_TICK, MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import type { GameState, PrintRunState, SlotState } from '../state/game-state.js';
import { creditDesignPrints, productValueOf } from './designs.js';
import { bankScrap, chargePerPrint, resolveBatchFailures, scrapFromFailure } from './failure.js';
import { isQueueRunning, nextQueueEntry, queueEntryDone, queueStockFloor } from './queue.js';
import { addPool, withFilament } from './resources.js';
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

/**
 * What a bay is set up to make. Since M5 that is either a stock **Object**
 * (which yields Parts) or one of the player's **Designs** (which yields
 * Products, spec §5D) — never both, and the rest of the print loop is written
 * against the flattened numbers rather than against which of the two it is.
 *
 * `recipeId`/`recipeName` are whichever of the pair is loaded, so events, the
 * projection and the bots name the thing being printed without asking.
 */
export type PrintPool = 'parts' | 'products';

/** What every loaded bay has, whichever of the two it is holding. */
interface SlotConfigBase {
  readonly material: MaterialDef;
  readonly recipeId: string;
  readonly recipeName: string;
  readonly printDesignSeconds: number;
  readonly filamentGrams: number;
}

export interface ObjectSlotConfig extends SlotConfigBase {
  /** Which valued pool a successful print fills (spec §2). */
  readonly pool: 'parts';
  readonly object: ObjectDef;
  readonly design: null;
}

export interface DesignSlotConfig extends SlotConfigBase {
  readonly pool: 'products';
  readonly object: null;
  readonly design: DesignDef;
}

/**
 * A discriminated union rather than two nullable fields, so "exactly one of
 * them is loaded" is a fact the type checker enforces. The alternative needs a
 * `config.object === null` branch after the Design case that nothing can ever
 * reach — dead code the tests cannot cover and the mutation gate is right to
 * complain about.
 */
export type SlotConfig = ObjectSlotConfig | DesignSlotConfig;

function objectConfig(material: MaterialDef, object: ObjectDef): ObjectSlotConfig {
  return {
    material,
    object,
    design: null,
    recipeId: object.id,
    recipeName: object.name,
    printDesignSeconds: object.printDesignSeconds,
    filamentGrams: object.filamentGrams,
    pool: 'parts',
  };
}

function designConfig(material: MaterialDef, design: DesignDef): DesignSlotConfig {
  return {
    material,
    object: null,
    design,
    recipeId: design.id,
    recipeName: design.name,
    printDesignSeconds: design.printDesignSeconds,
    filamentGrams: design.filamentGrams,
    pool: 'products',
  };
}

export function resolveSlotConfig(content: Content, slot: SlotState): SlotConfig | null {
  if (slot.materialId === null) {
    return null;
  }
  const material = indexById(content.materials).get(slot.materialId);
  if (material === undefined) {
    return null;
  }
  if (slot.designId !== null) {
    const design = indexById(content.designs).get(slot.designId);
    return design === undefined ? null : designConfig(material, design);
  }
  if (slot.objectId === null) {
    return null;
  }
  const object = indexById(content.objects).get(slot.objectId);
  return object === undefined ? null : objectConfig(material, object);
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
  return (config.printDesignSeconds * MS_PER_SECOND) / speed;
}

export function filamentPerBatch(config: SlotConfig, batch: number): number {
  return config.filamentGrams * batch;
}

/** How many of a slot's printers the filament in stock can actually feed. */
export function affordableBatch(config: SlotConfig, printerCount: number, grams: number): number {
  const perPrint = config.filamentGrams;
  if (perPrint <= NONE) {
    throw new RangeError(`recipe "${config.recipeId}" must consume filament`);
  }
  return Math.min(printerCount, Math.floor(grams / perPrint));
}

export interface BatchYield {
  /** Units produced — Parts for an object, Products for a Design. */
  readonly count: number;
  readonly value: number;
  readonly pool: PrintPool;
}

/**
 * What the *successful* prints in a batch are worth.
 *
 * An object yields its `partsYield` per print at the material's value; a Design
 * yields one Product per print at whatever its current level makes it worth
 * (spec §5D). `designLevel` is passed in rather than read here so this stays a
 * pure function of the recipe and the modifiers.
 */
export function batchYield(
  config: SlotConfig,
  batch: number,
  modifiers: ModifierMap,
  curves: CurveRegistry,
  designLevel: number,
): BatchYield {
  if (config.pool === 'products') {
    return {
      count: batch,
      value: batch * productValueOf(config.design, curves, designLevel, modifiers),
      pool: config.pool,
    };
  }
  const count =
    config.object.partsYield * batch * modifierOf(modifiers, 'partsYieldMultiplier', FULL);
  return {
    count,
    value: count * config.object.basePartValue * config.material.valueMultiplier,
    pool: config.pool,
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
  // Exactly one of the two is loaded, so the other is always cleared: a bay
  // that switches from a Design to an object must stop making Products.
  const loaded = {
    materialId: next.material.id,
    objectId: next.object?.id ?? null,
    designId: next.design?.id ?? null,
  } as const;
  const switching = slot.materialId !== null && slot.materialId !== next.material.id;
  if (!switching) {
    return {
      state,
      changeover: {
        slot: { ...slot, ...loaded },
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
        ...loaded,
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
    recipeId: config.recipeId,
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
  curves: CurveRegistry,
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
  const level =
    config.pool === 'products' ? (state.designs[config.design.id]?.level ?? NONE) : NONE;
  const produced = batchYield(config, outcome.succeeded, modifiers, curves, level);
  const scrapped = scrapFromFailure(config.material, config.filamentGrams * outcome.failed);

  const banked = bankScrap(addPool(state, produced.pool, produced.count, produced.value), scrapped);
  // A Design levels on what it *made*, so only the successful prints count.
  const progress =
    config.pool === 'products'
      ? creditDesignPrints(banked.designs, config.design, outcome.succeeded)
      : { designs: banked.designs, levelUp: null };
  const madeProducts = produced.pool === 'products';
  const counted: GameState = {
    ...banked,
    designs: progress.designs,
    stats: {
      ...banked.stats,
      printsCompleted: banked.stats.printsCompleted + outcome.succeeded,
      printsFailed: banked.stats.printsFailed + outcome.failed,
      partsProduced: banked.stats.partsProduced + (madeProducts ? NONE : produced.count),
      productsProduced: banked.stats.productsProduced + (madeProducts ? produced.count : NONE),
    },
  };
  emit?.({
    type: 'PRINT_COMPLETED',
    simTimeMs: state.simTimeMs,
    slotId: slot.id,
    recipeId: config.recipeId,
    materialId: config.material.id,
    batch: run.batch,
    produced: produced.count,
    pool: produced.pool,
    value: produced.value,
    failed: outcome.failed,
    scrapGrams: scrapped.grams,
  });
  if (progress.levelUp !== null) {
    emit?.({
      type: 'DESIGN_LEVELLED',
      simTimeMs: state.simTimeMs,
      designId: progress.levelUp.designId,
      level: progress.levelUp.level,
    });
  }
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
  const rotated = rotateQueue(idle, content, index, run.remainingMs, emit);
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
 *
 * `carryMs` is the (non-positive) overshoot of the batch that just finished,
 * and the purge starts that much further along — the same rule the restart path
 * follows, for the same reason: a tick that ends in a rotation must not quietly
 * lose the fraction of itself that was left over.
 */
function rotateQueue(
  state: GameState,
  content: Content,
  index: number,
  carryMs: number,
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
  // A rota names stock objects, so a rotation always leaves Design mode.
  const config = resolveSlotConfig(content, {
    ...slot,
    materialId: entry.materialId,
    objectId: entry.objectId,
    designId: null,
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
    recipeId: config.recipeId,
    downtimeMs: changeover.downtimeMs,
    purgedGrams: changeover.purgedGrams,
    abandonedBatch: NONE,
  });
  return withSlot(purged, index, {
    ...changeover.slot,
    changeoverMs: Math.max(changeover.slot.changeoverMs + carryMs, NONE),
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
  curves: CurveRegistry = createCurveRegistry(content.curves),
): GameState {
  let next = state;
  for (let index = NONE; index < next.slots.length; index += FULL) {
    next = tickSlot(next, content, index, dtMs, emit, modifiers, curves);
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
  curves: CurveRegistry,
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
    next = completeRun(next, content, index, emit, modifiers, curves);
    completions += FULL;
  }
  return next;
}
