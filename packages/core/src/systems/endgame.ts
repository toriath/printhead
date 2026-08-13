import type { Content, FabricatorDef, NewGamePlusModifier } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import { clamp } from '../math/scalar.js';
import type { FabricatorRunState, GameState, SlotState } from '../state/game-state.js';
import { createInitialState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { grantPrinter, payCost } from './economy.js';
import { isEndingComplete } from './ending.js';
import { slotWithRoom } from './fleet.js';
import { chosenFork } from './forks.js';
import { withFilament } from './resources.js';
import { effectiveSlotCapacity } from './slots.js';
import { type ModifierMap, isInstalled, modifierOf } from './upgrades.js';

/**
 * The Endgame (spec §5E, §6 phases 5–6, §7.3).
 *
 * Four mechanics live here, and every one of them is an interpreter of
 * `content/endgame.json`:
 *
 * - **the printed factory** — a node that turns out machines by itself;
 * - **pre-printed sections** — how a Farm build stays viable for a final print
 *   only the Goliath fork may attempt (spec §7.3);
 * - **the Universal Fabricator** — the last print, which commits every bay;
 * - **the ending** — numbers, museum, credits, timed off the clock alone, and
 *   then New Game Plus.
 *
 * Nothing here names a node, a material or a fork: the blueprint is whichever
 * upgrade `fabricator.requiresUpgradeId` points at, the feedstock is whichever
 * material it names, and the fork that may attempt the print is whichever one
 * declares `requiredForFinalPrint`. Re-pointing any of them is a JSON edit.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

// --- the Endgame Tree --------------------------------------------------------

/**
 * The backdrop the workshop is drawn against (spec §5E: "print a building
 * (backdrop change)"). The last entry whose node is installed wins, so the list
 * reads as a progression and the renderer only ever receives an id.
 */
export function currentBackdropId(state: GameState, content: Content): string {
  let backdrop = content.endgame.backdrops[NONE]?.id ?? '';
  for (const def of content.endgame.backdrops) {
    if (def.requiresUpgradeId !== null && isInstalled(state, def.requiresUpgradeId)) {
      backdrop = def.id;
    }
  }
  return backdrop;
}

// --- the printed factory (spec §5E) ------------------------------------------

/** Machines the factory turns out per design-minute; zero without one. */
export function factoryRate(modifiers: ModifierMap): number {
  return modifierOf(modifiers, 'printerFactoryRate', NONE);
}

/**
 * Run the factory for `dtMs` of design time.
 *
 * Fractions of a machine are banked in `factoryProgress` and only whole
 * machines join the fleet, so the factory is exactly time-additive: splitting a
 * catch-up in half produces the same workshop (spec §13). A machine with
 * nowhere to stand is not built — bays hold a fixed number (spec §4) — and the
 * accumulator is held at one finished machine so a full rack cannot bank an
 * arbitrarily large backlog while the player is away.
 */
export function tickFactory(
  state: GameState,
  content: Content,
  dtMs: number,
  modifiers: ModifierMap,
  emit: EventSink | undefined,
): GameState {
  const rate = factoryRate(modifiers);
  if (rate <= NONE || dtMs <= NONE) {
    return state;
  }
  const printerId = content.endgame.factory.printerId;
  let next: GameState = {
    ...state,
    factoryProgress: state.factoryProgress + (rate * dtMs) / MS_PER_MINUTE,
  };
  while (next.factoryProgress >= ONE) {
    const bay = slotWithRoom(next, content);
    if (bay === null) {
      // Nowhere to put it: hold the accumulator at one finished machine so the
      // factory resumes the instant a bay opens without paying out a backlog.
      return { ...next, factoryProgress: ONE };
    }
    const granted = grantPrinter(next, printerId);
    const index = next.slots.findIndex((slot) => slot.id === bay.id);
    const slots = granted.state.slots.map((slot, at) =>
      at === index ? { ...slot, printerCount: slot.printerCount + ONE } : slot,
    );
    next = {
      ...granted.state,
      slots,
      factoryProgress: next.factoryProgress - ONE,
    };
    emit?.({
      type: 'PRINTER_BUILT',
      simTimeMs: next.simTimeMs,
      printerId,
      slotId: bay.id,
      owned: granted.owned,
      paid: NONE,
    });
  }
  return next;
}

// --- pre-printed sections (spec §7.3) ----------------------------------------

export type SectionRejection =
  | 'locked'
  | 'max-level'
  | 'slot-busy'
  | 'already-built'
  | 'insufficient-resources';

export function fabricatorDef(content: Content): FabricatorDef {
  return content.endgame.fabricator;
}

export function hasBlueprint(state: GameState, content: Content): boolean {
  return isInstalled(state, fabricatorDef(content).requiresUpgradeId);
}

/** Price of the next section: its position on the curve, rounded up if countable. */
export function nextSectionCost(state: GameState, content: Content, curves: CurveRegistry): Cost {
  const def = fabricatorDef(content);
  const cost = nextCost(
    curves,
    { costCurveId: def.sectionCostCurveId, costResource: def.sectionCostResource },
    state.fabricator.sections,
  );
  return cost.resource === 'money' ? cost : { ...cost, amount: Math.ceil(cost.amount) };
}

/** Why another section cannot be started, or `null` when one can. */
export function sectionAvailability(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): SectionRejection | null {
  const def = fabricatorDef(content);
  if (!hasBlueprint(state, content)) {
    return 'locked';
  }
  if (state.fabricator.completedAtMs !== null) {
    return 'already-built';
  }
  if (state.fabricator.sections >= def.maxSections) {
    return 'max-level';
  }
  if (state.fabricator.sectionRun !== null || state.fabricator.run !== null) {
    return 'slot-busy';
  }
  const cost = nextSectionCost(state, content, curves);
  const stock = state.filamentGrams[def.materialId] ?? NONE;
  if (stock < def.sectionFilamentGrams) {
    return 'insufficient-resources';
  }
  return cost.resource !== 'filament' && state.resources[cost.resource] >= cost.amount
    ? null
    : 'insufficient-resources';
}

export interface SectionStart {
  readonly state: GameState;
  readonly cost: Cost;
  readonly durationMs: number;
}

/** Pay for a section and put it on the bed; the tick finishes it. */
export function startSection(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): SectionStart | null {
  const def = fabricatorDef(content);
  const cost = nextSectionCost(state, content, curves);
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const totalMs = def.sectionDesignMinutes * MS_PER_MINUTE;
  return {
    cost,
    durationMs: totalMs,
    state: {
      ...paid,
      filamentGrams: withFilament(paid.filamentGrams, def.materialId, -def.sectionFilamentGrams),
      fabricator: { ...paid.fabricator, sectionRun: { remainingMs: totalMs, totalMs } },
    },
  };
}

// --- the Universal Fabricator (spec §6 phase 6) ------------------------------

/**
 * How long the final print takes right now. Every pre-printed section takes
 * `sectionDesignMinutes` off it, down to the content's floor — so sections are
 * worth printing without ever making the last print a formality.
 */
export function fabricatorDurationMs(state: GameState, content: Content): number {
  const def = fabricatorDef(content);
  const minutes = Math.max(
    def.designMinutes - state.fabricator.sections * def.sectionDesignMinutes,
    def.minDesignMinutes,
  );
  return minutes * MS_PER_MINUTE;
}

/** The bays the workshop is actually running — all of which must commit. */
export function committedSlots(state: GameState, content: Content): readonly SlotState[] {
  return state.slots.slice(NONE, effectiveSlotCapacity(state, content));
}

/**
 * Is the whole workshop behind the print? Spec §4: "the final Fabricator print
 * requires **all slots** — a deliberate return to total commitment".
 *
 * Two conditions, and both are needed. Every active bay must be manned, because
 * a bay standing empty is a bay that is not committed — and the fleet as a
 * whole must reach `fabricator.requiredPrinters`, because under a Goliath run
 * there is only ever one bay and "all of them" would otherwise be satisfied by
 * a single machine.
 */
export function committedPrinters(state: GameState, content: Content): number {
  let total = NONE;
  for (const slot of committedSlots(state, content)) {
    total += slot.printerCount;
  }
  return total;
}

export function allSlotsCommitted(state: GameState, content: Content): boolean {
  const bays = committedSlots(state, content);
  if (bays.length <= NONE || bays.some((slot) => slot.printerCount <= NONE)) {
    return false;
  }
  return committedPrinters(state, content) >= fabricatorDef(content).requiredPrinters;
}

/**
 * Does the run's fork allow the final print (spec §7.3)? The rule is read off
 * the fork defs: if any branch declares `requiredForFinalPrint`, only such a
 * branch may attempt it. Content that declares none lets any build try.
 */
export function forkAllowsFinalPrint(state: GameState, content: Content): boolean {
  if (!content.forks.some((def) => def.requiredForFinalPrint)) {
    return true;
  }
  return chosenFork(state, content)?.requiredForFinalPrint ?? false;
}

export type FabricatorRejection =
  | 'locked'
  | 'already-built'
  | 'slot-busy'
  | 'wrong-fork'
  | 'slots-not-committed'
  | 'insufficient-resources';

/** Why the final print cannot start, or `null` when it can. */
export function fabricatorAvailability(
  state: GameState,
  content: Content,
): FabricatorRejection | null {
  const def = fabricatorDef(content);
  if (!hasBlueprint(state, content)) {
    return 'locked';
  }
  if (state.fabricator.completedAtMs !== null) {
    return 'already-built';
  }
  if (state.fabricator.run !== null || state.fabricator.sectionRun !== null) {
    return 'slot-busy';
  }
  if (!forkAllowsFinalPrint(state, content)) {
    return 'wrong-fork';
  }
  if (!allSlotsCommitted(state, content)) {
    return 'slots-not-committed';
  }
  return (state.filamentGrams[def.materialId] ?? NONE) >= def.filamentGrams
    ? null
    : 'insufficient-resources';
}

/**
 * Commit the workshop. Every active bay is stripped back to its machines — the
 * config, the run and the rota all go — because the whole fleet is now printing
 * one thing (spec §4). The filament goes in up front, exactly as an ordinary
 * batch does.
 */
export function beginFabricatorPrint(state: GameState, content: Content): GameState | null {
  if (fabricatorAvailability(state, content) !== null) {
    return null;
  }
  const def = fabricatorDef(content);
  const totalMs = fabricatorDurationMs(state, content);
  const committed = effectiveSlotCapacity(state, content);
  const slots = state.slots.map((slot, index) =>
    index < committed
      ? {
          ...slot,
          materialId: null,
          objectId: null,
          designId: null,
          autoRestart: false,
          run: null,
          changeoverMs: NONE,
          queue: [],
          queueIndex: NONE,
          queueBatches: NONE,
        }
      : slot,
  );
  return {
    ...state,
    slots,
    filamentGrams: withFilament(state.filamentGrams, def.materialId, -def.filamentGrams),
    fabricator: { ...state.fabricator, run: { remainingMs: totalMs, totalMs } },
  };
}

function advance(run: FabricatorRunState, dtMs: number): FabricatorRunState {
  return { ...run, remainingMs: run.remainingMs - dtMs };
}

/** 0..1 through a build; a finished one reads as fully printed. */
export function buildProgress(run: FabricatorRunState | null): number {
  if (run === null || run.totalMs <= NONE) {
    return NONE;
  }
  return clamp((run.totalMs - run.remainingMs) / run.totalMs, NONE, ONE);
}

/**
 * Which layer the synced render is on (spec §6: "the one synced render — layer
 * by layer"). Derived from the run's own progress so the renderer needs no
 * clock of its own and two viewers of the same save see the same layer.
 */
export function currentLayer(state: GameState, content: Content): number {
  const layers = fabricatorDef(content).layers;
  const run = state.fabricator.run;
  if (run === null) {
    return state.fabricator.completedAtMs === null ? NONE : layers;
  }
  return Math.min(Math.floor(buildProgress(run) * layers), layers);
}

/** Advance the section on the bed and the final print, in that order. */
export function tickFabricator(
  state: GameState,
  content: Content,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  if (dtMs <= NONE) {
    return state;
  }
  const def = fabricatorDef(content);
  let fabricator = state.fabricator;
  const sectionRun = fabricator.sectionRun;
  if (sectionRun !== null) {
    const advanced = advance(sectionRun, dtMs);
    if (advanced.remainingMs > NONE) {
      fabricator = { ...fabricator, sectionRun: advanced };
    } else {
      fabricator = { ...fabricator, sectionRun: null, sections: fabricator.sections + ONE };
      emit?.({
        type: 'FABRICATOR_SECTION_PRINTED',
        simTimeMs: state.simTimeMs,
        sections: fabricator.sections,
        maxSections: def.maxSections,
      });
    }
  }
  const run = fabricator.run;
  if (run !== null) {
    const advanced = advance(run, dtMs);
    if (advanced.remainingMs > NONE) {
      fabricator = { ...fabricator, run: advanced };
    } else {
      fabricator = { ...fabricator, run: null, completedAtMs: state.simTimeMs };
      emit?.({
        type: 'FABRICATOR_COMPLETED',
        simTimeMs: state.simTimeMs,
        designMinutes: state.simTimeMs / MS_PER_MINUTE,
      });
    }
  }
  return fabricator === state.fabricator ? state : { ...state, fabricator };
}

// --- New Game Plus (spec §18 M6) ---------------------------------------------

export function newGamePlusModifiers(
  content: Content,
  modifierIds: readonly string[],
): readonly NewGamePlusModifier[] {
  return content.endgame.newGamePlus.modifiers.filter((def) => modifierIds.includes(def.id));
}

export type NewGamePlusRejection = 'not-ready';

export function newGamePlusAvailability(
  state: GameState,
  content: Content,
): NewGamePlusRejection | null {
  return isEndingComplete(state, content) ? null : 'not-ready';
}

export interface NewGamePlusResult {
  readonly state: GameState;
  readonly run: number;
  readonly modifierIds: readonly string[];
}

/**
 * Start again (spec §18 M6: "new run keeping designs + optional modifiers").
 *
 * The next run is a *fresh* initial state — the same one a new game gets, so a
 * field added in a later milestone cannot be forgotten here — with the clock
 * back at zero and the arc back at the first phase. What crosses over is
 * exactly what `endgame.newGamePlus` names, plus two things that are facts about
 * the *player* rather than about the run: the seed's position, and that this
 * workshop knows how to assemble itself.
 *
 * Unknown modifier ids are dropped rather than rejected: the list is a menu the
 * player ticked, and content that stops offering a modifier should not make an
 * old save unplayable.
 */
export function startNewGamePlus(
  state: GameState,
  content: Content,
  modifierIds: readonly string[],
): NewGamePlusResult {
  const fresh = createInitialState(content, { seed: state.rng.seed });
  const { retainedResources, retainedLedgers } = content.endgame.newGamePlus;
  let resources = fresh.resources;
  for (const kind of retainedResources) {
    if (kind !== 'filament') {
      // Filament is per material, not a scalar balance, so it cannot be named
      // here — the same rule the melt-down follows (spec §5D).
      resources = { ...resources, [kind]: state.resources[kind] };
    }
  }
  let kept: Partial<GameState> = {};
  for (const ledger of retainedLedgers) {
    kept =
      ledger === 'designs'
        ? { ...kept, designs: state.designs }
        : { ...kept, moneyPrinters: state.moneyPrinters };
  }
  const taken = newGamePlusModifiers(content, modifierIds).map((def) => def.id);
  const run = state.ngPlus.run + ONE;
  return {
    run,
    modifierIds: taken,
    state: {
      ...fresh,
      rng: state.rng,
      resources,
      ...kept,
      // The Fabricator, the melt-down counter and everything else come from
      // `fresh`: this is a *new game*, and the only exceptions are the two
      // lines above and the two below.
      selfAssembling: state.selfAssembling,
      ngPlus: { run, modifierIds: taken },
    },
  };
}
