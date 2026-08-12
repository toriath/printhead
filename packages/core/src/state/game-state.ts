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

/** A config slot (spec §4): one `{ material, objectType }` plus its printers. */
export interface SlotState {
  readonly id: string;
  readonly materialId: string | null;
  readonly objectId: string | null;
  readonly printerCount: number;
  /** Keep printing the same config when a run finishes (the idle loop). */
  readonly autoRestart: boolean;
  readonly run: PrintRunState | null;
}

export interface StatsState {
  readonly printsCompleted: number;
  readonly partsProduced: number;
  readonly partsSold: number;
  readonly moneyEarned: number;
  readonly filamentPurchasedGrams: number;
}

export type ResourceLedger = Readonly<Record<ScalarResourceKind, number>>;
export type FilamentLedger = Readonly<Record<string, number>>;
export type PrinterLedger = Readonly<Record<string, number>>;

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
  /** Grams per material id (spec §2: filament is tracked per material). */
  readonly filamentGrams: FilamentLedger;
  /** How many of each printer def are owned. */
  readonly printers: PrinterLedger;
  readonly slots: readonly SlotState[];
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
  partsProduced: 0,
  partsSold: 0,
  moneyEarned: 0,
  filamentPurchasedGrams: 0,
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

export function createSlots(content: Content): readonly SlotState[] {
  const { slotCount, slotIdPrefix } = content.start;
  return Array.from({ length: slotCount }, (_unused, index) => ({
    id: slotIdAt(slotIdPrefix, index),
    materialId: null,
    objectId: null,
    printerCount: 0,
    autoRestart: false,
    run: null,
  }));
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
    filamentGrams: startingFilament(content),
    printers: {},
    slots: createSlots(content),
    assembly: { attachedPieceIds: [], cooldownMs: firstAssemblyCooldownMs(content) },
    stats: EMPTY_STATS,
  };
}
