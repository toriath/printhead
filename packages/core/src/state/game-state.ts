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
   * The Design this bay is printing (spec §5D), or `null` when it is printing
   * a stock object. Exactly one of `objectId`/`designId` is ever set: a bay
   * makes Parts or it makes Products, never both at once.
   */
  readonly designId: string | null;
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
  /**
   * Progress towards the next Perfect print, 0..1 (see `failure.perfectPrint`).
   * The good twin of `failureCharge`: deterministic, so it can be watched.
   */
  readonly perfectCharge: number;
  /** Design-milliseconds of overclock left on this bay; 0 when not boosted. */
  readonly overclockMs: number;
  /** Design-milliseconds until the bay can be overclocked again. */
  readonly overclockCooldownMs: number;
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

/** One order on the commission board (see `content/commissions.json`). */
export interface CommissionState {
  /** Issue number on the board — stable identity for the UI and the events. */
  readonly serial: number;
  readonly templateId: string;
  readonly clientId: string;
  /** Parts delivered so far towards the template's `count`. */
  readonly delivered: number;
  /** Design-milliseconds until the client gives up. */
  readonly remainingMs: number;
  /**
   * A proposal until the player takes it on. Only an accepted order counts
   * prints towards it; an unanswered proposal leaves when its window closes.
   */
  readonly accepted: boolean;
}

export interface CommissionBoardState {
  readonly open: readonly CommissionState[];
  /** Design-milliseconds until the next offer may arrive. */
  readonly nextOfferMs: number;
  /** Offers ever made this run; seeds the next draw. */
  readonly issued: number;
  /** Orders each client has had delivered: repeat business pays better. */
  readonly loyalty: Readonly<Record<string, number>>;
}

/** The shop front (see `content/shop.json`). */
export interface ShopState {
  readonly priceLevelId: string;
  /** 0..1 — earned by serving customers, lost by sending them away empty-handed. */
  readonly reputation: number;
  /** Design-milliseconds until the next customer walks in. */
  readonly nextCustomerMs: number;
  /** Customers ever seen this run; seeds who they are and what they want. */
  readonly visits: number;
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
  readonly productsProduced: number;
  readonly productsSold: number;
  /** Money the Plates have printed directly (spec §5E) — the inflation meter. */
  readonly moneyPrinted: number;
  /** Melt-downs completed. Survives prestige: it *counts* prestige (spec §5D). */
  readonly prestigeCount: number;
  /**
   * Plates engraved across the whole game, spent or not (spec §5E).
   *
   * The money printers read *this*, not the Plates in the pile. Reading the
   * balance made the endgame punish the only thing it sells: the Endgame Tree
   * is bought with Plates, so buying it switched the presses off and the run
   * could never earn its way back. An engraved plate keeps printing once it has
   * been made; what the tree spends is the metal, not the engraving.
   */
  readonly platesEarned: number;
  /** Commissions delivered on time, across the game. */
  readonly commissionsCompleted: number;
  /** Shop customers who left with Parts, and who left with nothing. */
  readonly customersServed: number;
  readonly customersMissed: number;
}

/**
 * One owned Design (spec §5D). `level` multiplies the Product's value through
 * the def's `levelValueCurveId`; `printsOnLevel` is progress towards the next
 * one. Designs are the game's only permanent progression — a melt-down copies
 * this ledger across untouched, which is the property test of spec §13.
 */
export interface DesignState {
  readonly level: number;
  readonly printsOnLevel: number;
}

/**
 * The studio bench while a Design is being drafted (spec §5D). One project at
 * a time: the studio is a *place*, not a queue, so drafting the Money Plate is
 * a decision with an opportunity cost rather than a shopping list entry.
 */
export interface StudioProjectState {
  readonly designId: string;
  /** Design-milliseconds of drafting left. Integer ms, like every clock here. */
  readonly remainingMs: number;
}

/**
 * A timed build on the Universal Fabricator (spec §6 phase 6): either the final
 * print itself or one pre-printed section. Milliseconds, like every other clock
 * in the state, so it lands on zero exactly.
 */
export interface FabricatorRunState {
  readonly remainingMs: number;
  readonly totalMs: number;
}

/**
 * The final print (spec §6 phase 6, §7.3).
 *
 * `sections` are the pieces a Farm build pre-printed to stay viable: each one
 * takes `sectionDesignMinutes` off the build, and whether they survive a
 * melt-down is `prestige.retainedLedgers`' decision, not this file's. That is
 * the mechanism behind "Goliath is required for the final print, but a Farm
 * build can pre-print sections" — the sections cross the melt-down, the fork
 * does not.
 *
 * `completedAtMs` is the simulation clock at the moment the Fabricator finished.
 * The ending sequence is timed from it (spec §6: numbers → museum → credits),
 * so the whole ending is a pure function of the clock rather than a script with
 * a state machine of its own.
 */
export interface FabricatorState {
  readonly sections: number;
  /** The section currently on the bed, or `null`. One at a time. */
  readonly sectionRun: FabricatorRunState | null;
  /** The final print in flight, or `null`. */
  readonly run: FabricatorRunState | null;
  readonly completedAtMs: number | null;
}

/**
 * New Game Plus (spec §18 M6). `run` counts how many times the game has been
 * finished and started again; `modifierIds` are the optional modifiers the
 * player took, folded into the modifier map by the same interpreter the upgrade
 * trees use — so a modifier is content, not a branch in the reducer.
 */
export interface NewGamePlusState {
  readonly run: number;
  readonly modifierIds: readonly string[];
}

export const EMPTY_FABRICATOR: FabricatorState = {
  sections: 0,
  sectionRun: null,
  run: null,
  completedAtMs: null,
};

export const EMPTY_NEW_GAME_PLUS: NewGamePlusState = { run: 0, modifierIds: [] };

export type ResourceLedger = Readonly<Record<ScalarResourceKind, number>>;
export type FilamentLedger = Readonly<Record<string, number>>;
export type PrinterLedger = Readonly<Record<string, number>>;
/** Installed level per upgrade id; absent means never bought. */
export type UpgradeLedger = Readonly<Record<string, number>>;
export type AutomationLedger = Readonly<Record<string, AutomationSlotState>>;
export type MarketLedger = Readonly<Record<string, MarketMaterialState>>;
/** Design id → its level and progress. Absent means "never drafted". */
export type DesignLedger = Readonly<Record<string, DesignState>>;
/** Money-printer id → installed level (spec §5E). */
export type MoneyPrinterLedger = Readonly<Record<string, number>>;

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
  /**
   * Money value of the Products in stock, banked exactly like `partsValue`.
   * A Product's worth is set by the level its Design was at when it printed,
   * so the pool has to carry the value rather than recompute it at the till.
   */
  readonly productsValue: number;
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
  /** Designs owned and their levels (spec §5D). Survives prestige, exactly. */
  readonly designs: DesignLedger;
  /** The design currently on the studio bench, or `null` when it is free. */
  readonly studio: StudioProjectState | null;
  /** Installed money-printer levels (spec §5E), the Plate sink. */
  readonly moneyPrinters: MoneyPrinterLedger;
  /**
   * Does the intro rebuild itself? Set by the first melt-down and never
   * cleared: once you have built a printer by hand, the workshop knows how
   * (spec §6 phase 4, "intro replays **self-assembling**"). It is state rather
   * than a reading of `stats.prestigeCount` because the projection, the
   * renderer and the reducer all ask the same question and none of them should
   * have to know the rule.
   */
  readonly selfAssembling: boolean;
  /**
   * The printed factory's accumulator (spec §5E). It turns out a fraction of a
   * machine per tick; the whole machines are banked into the fleet and the
   * remainder is carried here, which is what keeps the factory exactly
   * time-additive across an offline catch-up.
   */
  readonly factoryProgress: number;
  /** The Universal Fabricator and the sections pre-printed for it (spec §7.3). */
  readonly fabricator: FabricatorState;
  /** Which run of the game this is, and on what terms (spec §18 M6). */
  readonly ngPlus: NewGamePlusState;
  /** The commission board this run. */
  readonly commissions: CommissionBoardState;
  /** The shop front this run. */
  readonly shop: ShopState;
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
  productsProduced: 0,
  productsSold: 0,
  moneyPrinted: 0,
  prestigeCount: 0,
  platesEarned: 0,
  commissionsCompleted: 0,
  customersServed: 0,
  customersMissed: 0,
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
    productsValue: 0,
    filamentGrams: startingFilament(content),
    printers: {},
    upgrades: {},
    automation: {},
    market: createMarket(content),
    slots: createSlots(content),
    forkId: null,
    designs: {},
    studio: null,
    moneyPrinters: {},
    selfAssembling: false,
    factoryProgress: 0,
    fabricator: EMPTY_FABRICATOR,
    ngPlus: EMPTY_NEW_GAME_PLUS,
    commissions: {
      open: [],
      nextOfferMs: content.commissions.firstOfferDesignSeconds * MS_PER_SECOND,
      issued: 0,
      loyalty: {},
    },
    shop: {
      priceLevelId: content.shop.openingPriceLevel,
      reputation: content.shop.reputationStart,
      nextCustomerMs: content.shop.customerEveryDesignSeconds * MS_PER_SECOND,
      visits: 0,
    },
    assembly: { attachedPieceIds: [], cooldownMs: firstAssemblyCooldownMs(content) },
    stats: EMPTY_STATS,
  };
}
