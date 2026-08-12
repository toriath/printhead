import type { Content, ScalarResourceKind } from '../content/schema.js';
import { SCALAR_RESOURCE_KINDS } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import type { Rng, RngSnapshot } from '../rng/mulberry32.js';
import { SAVE_SCHEMA_VERSION } from '../save/version.js';
import { firstPhaseId } from '../systems/phases.js';

/**
 * The whole persistent simulation state (spec §15, Memento). Every field here
 * is saved, so every field added must ship a save-schema bump, a migration and
 * a fixture test in the same commit (spec §19).
 */

/**
 * Intro assembly: pieces are attached in content order, one click each.
 *
 * Durations are held in *milliseconds*, not seconds, throughout the running
 * state. Content authors design-seconds because that is what a human reasons
 * about, but a tick advances the clock by an integer `TICK_MS`, so keeping the
 * countdown in integer milliseconds makes it drift-free: subtracting 0.1 s
 * three hundred times does not land on zero in binary floating point, and the
 * whole offline-equivalence property (spec §13) depends on it landing exactly.
 */
export interface AssemblyState {
  readonly attachedPieceIds: readonly string[];
  /** Design-milliseconds of bench work left before the next piece attaches. */
  readonly cooldownMs: number;
}

/** One in-flight print run on a slot. `batch` printers ran it together. */
export interface PrintRunState {
  readonly remainingMs: number;
  readonly totalMs: number;
  readonly batch: number;
}

/**
 * One entry on a slot's print queue (spec §5B). A rota of configurations the
 * slot works through; `batches` is how many batches it prints before the
 * auto-changeover automation rotates it on to the next entry.
 */
export interface SlotQueueEntry {
  readonly materialId: string;
  readonly objectId: string;
  readonly batches: number;
}

/** A config slot (spec §4): one `{ material, objectType }` plus its printers. */
export interface SlotState {
  readonly id: string;
  readonly materialId: string | null;
  readonly objectId: string | null;
  /**
   * Printers assigned to this bay (spec §4). The fleet is a pool of identical
   * machines the player allocates across slots, so this is a count, and the sum
   * across every slot is exactly the number of printers owned — the invariant
   * `ASSIGN_PRINTER` is written to preserve.
   */
  readonly printerCount: number;
  /** Keep printing the same config when a run finishes (the idle loop). */
  readonly autoRestart: boolean;
  readonly run: PrintRunState | null;
  /**
   * Pity-timer charge (spec §7.1). Every print adds the loaded material's
   * charge rate; when it crosses the threshold a print fails. Deterministic on
   * purpose — the player can feel it coming, and an upgrade visibly slows it.
   */
  readonly failureCharge: number;
  /**
   * Design-milliseconds of changeover purge left before the slot can print
   * again (spec §3). Milliseconds for the same reason runs are: exact ticks.
   */
  readonly changeoverMs: number;
  /** The rota this bay works through (spec §5B); empty means "one config". */
  readonly queue: readonly SlotQueueEntry[];
  /** Which rota entry is currently loaded. */
  readonly queueIndex: number;
  /** Batches finished on the current entry, counted towards its `batches`. */
  readonly queueBatches: number;
}

/**
 * Per-material market state (spec §7.2). `pressure` is the player's own net
 * trading, positive when they have been flooding the market; the price model
 * subtracts it, so dumping filament makes filament cheap.
 */
export interface MarketMaterialState {
  readonly stockGrams: number;
  readonly pressure: number;
}

/** One purchased automation (spec §5C): a bot the machine runs for you. */
export interface AutomationSlotState {
  readonly level: number;
  readonly enabled: boolean;
  /** Player-tunable trigger; seeded from the def's `defaultThreshold`. */
  readonly threshold: number;
  /** Design-milliseconds until it next fires. */
  readonly cooldownMs: number;
}

export interface StatsState {
  readonly printsCompleted: number;
  readonly printsFailed: number;
  readonly partsProduced: number;
  readonly partsSold: number;
  readonly moneyEarned: number;
  readonly filamentPurchasedGrams: number;
  readonly filamentSoldGrams: number;
  readonly scrapProducedGrams: number;
  readonly scrapRecycledGrams: number;
}

export type ResourceLedger = Readonly<Record<ScalarResourceKind, number>>;
export type FilamentLedger = Readonly<Record<string, number>>;
export type PrinterLedger = Readonly<Record<string, number>>;
/** Installed level per upgrade id; absent means never bought. */
export type UpgradeLedger = Readonly<Record<string, number>>;
export type AutomationLedger = Readonly<Record<string, AutomationSlotState>>;
export type MarketLedger = Readonly<Record<string, MarketMaterialState>>;

export interface GameState {
  readonly saveVersion: number;
  readonly simTimeMs: number;
  readonly tickCount: number;
  readonly phaseId: string;
  /** Simulation clock when the current phase was entered (phase-timer metric). */
  readonly phaseEnteredAtMs: number;
  readonly rng: RngSnapshot;
  readonly resources: ResourceLedger;
  /**
   * Money value of the parts currently in stock. Parts are fungible but their
   * worth depends on the material they were printed in (spec §2), so the pool
   * carries an average value that selling and spending draw down pro rata.
   */
  readonly partsValue: number;
  /**
   * Money value carried by the Scrap pile, tracked exactly like `partsValue`.
   * The recycler hands back a fraction of *value*, not of grams, which is what
   * stops "recycle cheap scrap into dear filament" from minting money.
   */
  readonly scrapValue: number;
  /** Grams per material id (spec §2: filament is tracked per material). */
  readonly filamentGrams: FilamentLedger;
  /** How many of each printer def are owned. */
  readonly printers: PrinterLedger;
  /** Installed upgrade levels (spec §5); the modifier interpreter reads this. */
  readonly upgrades: UpgradeLedger;
  /** Purchased automations and their player-set thresholds (spec §5C). */
  readonly automation: AutomationLedger;
  /** Per-material market stock and trading pressure (spec §7.2). */
  readonly market: MarketLedger;
  readonly slots: readonly SlotState[];
  /**
   * The per-run Farm/Goliath commitment (spec §5B), or `null` before it is
   * made. Mutually exclusive by construction: there is one field, the reducer
   * only ever writes it when it is `null`, and a prestige run is what clears it
   * (M5).
   */
  readonly forkId: string | null;
  readonly assembly: AssemblyState;
  readonly stats: StatsState;
}

export interface ReduceContext {
  readonly content: Content;
  /** Injected clock — `core` never calls `Date.now` (spec §13). */
  readonly nowMs: number;
  /** Injected deterministic stream — `core` never calls `Math.random`. */
  readonly rng: Rng;
  /** Optional domain-event sink (Observer, spec §15). */
  readonly emit?: EventSink;
}

export interface InitialStateOptions {
  readonly seed: number;
}

export const EMPTY_ASSEMBLY: AssemblyState = { attachedPieceIds: [], cooldownMs: 0 };

export const EMPTY_STATS: StatsState = {
  printsCompleted: 0,
  printsFailed: 0,
  partsProduced: 0,
  partsSold: 0,
  moneyEarned: 0,
  filamentPurchasedGrams: 0,
  filamentSoldGrams: 0,
  scrapProducedGrams: 0,
  scrapRecycledGrams: 0,
};

export function zeroResources(): ResourceLedger {
  const ledger: Partial<Record<ScalarResourceKind, number>> = {};
  for (const kind of SCALAR_RESOURCE_KINDS) {
    ledger[kind] = 0;
  }
  return ledger as ResourceLedger;
}

/** `slot-1`, `slot-2`, … — ids are content-driven so the editor can rename them. */
export function slotIdAt(prefix: string, index: number): string {
  return `${prefix}-${index + 1}`;
}

export function emptySlot(id: string): SlotState {
  return {
    id,
    materialId: null,
    objectId: null,
    printerCount: 0,
    autoRestart: false,
    run: null,
    failureCharge: 0,
    changeoverMs: 0,
    queue: [],
    queueIndex: 0,
    queueBatches: 0,
  };
}

export function createSlots(content: Content): readonly SlotState[] {
  const { slotCount, slotIdPrefix } = content.start;
  return Array.from({ length: slotCount }, (_unused, index) =>
    emptySlot(slotIdAt(slotIdPrefix, index)),
  );
}

/** Opening stock and a neutral price for every tradeable material (spec §7.2). */
export function createMarket(content: Content): MarketLedger {
  const market: Record<string, MarketMaterialState> = {};
  for (const listing of content.market.listings) {
    market[listing.materialId] = { stockGrams: listing.stockGrams, pressure: 0 };
  }
  return market;
}

function startingFilament(content: Content): FilamentLedger {
  const grams: Record<string, number> = {};
  for (const material of content.materials) {
    grams[material.id] = 0;
  }
  for (const entry of content.start.startingFilament) {
    grams[entry.materialId] = (grams[entry.materialId] ?? 0) + entry.grams;
  }
  return grams;
}

function firstAssemblyCooldownMs(content: Content): number {
  return (content.start.assemblyPieces[0]?.attachDesignSeconds ?? 0) * MS_PER_SECOND;
}

export function createInitialState(content: Content, options: InitialStateOptions): GameState {
  return {
    saveVersion: SAVE_SCHEMA_VERSION,
    simTimeMs: 0,
    tickCount: 0,
    phaseId: firstPhaseId(content.pacing.phases),
    phaseEnteredAtMs: 0,
    rng: { seed: options.seed, count: 0 },
    resources: { ...zeroResources(), ...content.start.startingResources },
    partsValue: 0,
    scrapValue: 0,
    filamentGrams: startingFilament(content),
    printers: {},
    upgrades: {},
    automation: {},
    market: createMarket(content),
    slots: createSlots(content),
    forkId: null,
    assembly: { attachedPieceIds: [], cooldownMs: firstAssemblyCooldownMs(content) },
    stats: EMPTY_STATS,
  };
}
