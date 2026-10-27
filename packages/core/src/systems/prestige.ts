import type { Content, MoneyPrinterDef } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { evaluateCurveById } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { hashUnit } from '../rng/mulberry32.js';
import type { GameState, MoneyPrinterLedger, UpgradeLedger } from '../state/game-state.js';
import { createInitialState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { hasCapstoneDesign } from './designs.js';
import { payCost } from './economy.js';
import { isPhaseReached } from './phases.js';
import { withResource } from './resources.js';
import { computeModifiers, modifierOf } from './upgrades.js';

/**
 * Prestige — the melt-down (spec §5D) — and the money printer it pays for
 * (spec §5E).
 *
 * The whole run is scrapped and re-cast as **Plates**: printers, upgrades,
 * automations, filament, bays and the fork all go. Two things survive, and
 * `prestige.retainedResources` is the only place that says which, so "prestige
 * preserves Designs exactly" is a fact about the data as much as about the
 * code (spec §13).
 *
 * The rebuild is not free. The workshop starts from a bare bench again, but it
 * has done this before, so the intro **replays itself**: `selfAssembling` is
 * set once and never cleared, and the tick attaches the pieces through the very
 * same reducer path a clicking player uses (spec §6 phase 4).
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

// --- the melt-down ----------------------------------------------------------

/**
 * The reading the plate curve is evaluated at: how much of the run's chosen
 * input resource there is, scaled by content. Both the resource and the scale
 * are data, so "Plates are earned by banking money" is a design decision that
 * lives in `prestige.json` and nowhere else.
 */
export function plateInput(state: GameState, content: Content): number {
  const { plateInputResource, plateInputScale } = content.prestige;
  if (plateInputResource === 'filament') {
    // Filament is per material, not a scalar balance — nothing can be read
    // from it without saying which, so it cannot drive the reward.
    return NONE;
  }
  return state.resources[plateInputResource] * plateInputScale;
}

/**
 * Plates a melt-down would award right now. Whole Plates only: a Plate is an
 * engraved sheet of metal, and the curve is authored so that the *scale* of the
 * run, not its last few coins, is what buys another one.
 */
export function platesFor(state: GameState, content: Content, curves: CurveRegistry): number {
  const reading = plateInput(state, content);
  if (reading <= NONE) {
    return NONE;
  }
  const bonus = modifierOf(computeModifiers(state, content), 'platesMultiplier', ONE);
  return Math.floor(evaluateCurveById(curves, content.prestige.plateCurveId, reading) * bonus);
}

/**
 * The run modifiers a melt-down offers, drawn by a seeded hash of the run
 * number so a replay is offered the same three, and each melt-down a fresh
 * hand.
 */
export function offeredRunModifiers(
  state: GameState,
  content: Content,
): readonly Content['prestige']['runModifiers'][number][] {
  const run = state.stats.prestigeCount;
  return [...content.prestige.runModifiers]
    .map((def) => ({ def, draw: hashUnit(`run-modifier:${run}:${def.id}`, state.rng.seed) }))
    .sort((a, b) => a.draw - b.draw)
    .slice(NONE, content.prestige.runModifierOffers)
    .map((entry) => entry.def);
}

export type PrestigeRejection = 'locked' | 'missing-prerequisite' | 'not-worth-it';

/** Why the workshop cannot melt itself down yet, or `null` when it can. */
export function prestigeAvailability(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): PrestigeRejection | null {
  if (!isPhaseReached(content.pacing.phases, state.phaseId, content.prestige.unlockPhaseId)) {
    return 'locked';
  }
  // The capstone is the gate (spec §5D): no Money Plate, no prestige.
  if (!hasCapstoneDesign(state, content)) {
    return 'missing-prerequisite';
  }
  return platesFor(state, content, curves) >= content.prestige.minimumPlates
    ? null
    : 'not-worth-it';
}

export interface PrestigeResult {
  readonly state: GameState;
  readonly platesAwarded: number;
}

/**
 * Ledgers the melt-down carries across whole, named by `retainedLedgers` so
 * nothing here decides what survives. Each is copied by reference — not
 * remade, not rescaled, not reset — which is exactly what "preserves Designs
 * **exactly**" (spec §13) asks for.
 */
function retainedLedgers(state: GameState, content: Content, fresh: GameState): Partial<GameState> {
  let kept: Partial<GameState> = {};
  for (const ledger of content.prestige.retainedLedgers) {
    switch (ledger) {
      case 'designs':
        kept = { ...kept, designs: state.designs };
        break;
      case 'moneyPrinters':
        kept = { ...kept, moneyPrinters: state.moneyPrinters };
        break;
      case 'endgameTree':
        kept = { ...kept, upgrades: endgameLevels(state, content) };
        break;
      case 'fabricator':
        // The *sections* survive, not the build: a print in flight belongs to
        // the workshop that was melted down (spec §7.3).
        kept = {
          ...kept,
          fabricator: { ...fresh.fabricator, sections: state.fabricator.sections },
        };
        break;
    }
  }
  return kept;
}

/** Just the Endgame Tree's levels — everything else in the ledger is scrapped. */
function endgameLevels(state: GameState, content: Content): UpgradeLedger {
  const kept: Record<string, number> = {};
  for (const def of content.upgrades) {
    const level = state.upgrades[def.id];
    if (def.tree === 'endgame' && level !== undefined) {
      kept[def.id] = level;
    }
  }
  return kept;
}

/**
 * Melt the workshop down.
 *
 * The next run is a *fresh* initial state — built by the same
 * `createInitialState` a new game uses, so a resource added in a later
 * milestone cannot be forgotten here — with four things carried across: the
 * clock and the phase (prestige happens *inside* the arc, it does not restart
 * it), the rng position, the retained resources, and the retained ledgers.
 *
 * The rebuild costs `meltdownDesignSeconds` on top of the intro's own bench
 * work, which is why prestige is a decision rather than a reflex.
 */
export function meltDown(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  runModifierId: string | null = null,
): PrestigeResult {
  const platesAwarded = platesFor(state, content, curves);
  // The seed is handed over only to satisfy `createInitialState`; the run's own
  // rng — position and all — is put back below, because a melt-down happens
  // *inside* the arc and rewinding the stream would replay its dice.
  const fresh = createInitialState(content, { seed: state.rng.seed });
  let resources = fresh.resources;
  for (const kind of content.prestige.retainedResources) {
    if (kind === 'filament') {
      continue;
    }
    resources = { ...resources, [kind]: state.resources[kind] };
  }
  resources = withResource(resources, 'plates', platesAwarded);
  return {
    platesAwarded,
    state: {
      ...fresh,
      simTimeMs: state.simTimeMs,
      tickCount: state.tickCount,
      phaseId: state.phaseId,
      phaseEnteredAtMs: state.phaseEnteredAtMs,
      rng: state.rng,
      resources,
      ...retainedLedgers(state, content, fresh),
      selfAssembling: true,
      /*
       * New Game Plus is a fact about the *game*, not about the run: the
       * modifiers the player took are in force until they start again. A
       * melt-down that reset them would quietly change the difficulty
       * mid-playthrough — which is exactly what it did until a bot played
       * through the ending and melted down on the far side of it.
       */
      ngPlus: state.ngPlus,
      // The modifier picked for the run that starts now (null: none taken).
      runModifierId,
      // The workshop is scrapped, not the relationships: clients remember
      // who delivered, and the shop's name means what it meant.
      commissions: { ...fresh.commissions, loyalty: state.commissions.loyalty },
      shop: {
        ...fresh.shop,
        reputation: state.shop.reputation,
        priceLevelId: state.shop.priceLevelId,
      },
      assembly: {
        ...fresh.assembly,
        cooldownMs:
          fresh.assembly.cooldownMs + content.prestige.meltdownDesignSeconds * MS_PER_SECOND,
      },
      stats: {
        ...fresh.stats,
        // Two counters measure the *player*, not the run, and survive the
        // melt-down: how many times they have done this, and how much money
        // the presses have put into the world. The second one is what drives
        // inflation (spec §6 phase 5), and money already printed does not
        // un-print itself when a workshop is scrapped.
        prestigeCount: state.stats.prestigeCount + ONE,
        moneyPrinted: state.stats.moneyPrinted,
        platesEarned: state.stats.platesEarned + platesAwarded,
        commissionsCompleted: state.stats.commissionsCompleted,
        customersServed: state.stats.customersServed,
        customersMissed: state.stats.customersMissed,
      },
    },
  };
}

// --- money printing (spec §5E) ----------------------------------------------

export function moneyPrinterLevel(state: GameState, moneyPrinterId: string): number {
  return state.moneyPrinters[moneyPrinterId] ?? NONE;
}

export function countMoneyPrinters(state: GameState): number {
  let total = NONE;
  for (const level of Object.values(state.moneyPrinters)) {
    total += level;
  }
  return total;
}

/**
 * Money printed per design-second (spec §5E).
 *
 * Each installed tier contributes `rateCurve(plates) × level`, so the rate is
 * **monotone in Plates** by construction: the curve is read at the Plate count
 * and nothing else scales it down. With no Plates there is nothing to print
 * with, however many machines are installed — the Plates *are* the plates.
 *
 * The count it reads is `stats.platesEarned`, every Plate the game has ever
 * engraved, rather than the balance in hand. Reading the balance made spending
 * Plates switch the presses off, which turned the Endgame Tree — the only thing
 * Plates are for — into a punishment (see `StatsState.platesEarned`).
 */
export function moneyPrintRate(state: GameState, content: Content, curves: CurveRegistry): number {
  const plates = state.stats.platesEarned;
  if (plates <= NONE) {
    return NONE;
  }
  let rate = NONE;
  for (const def of content.prestige.moneyPrinters) {
    // An uninstalled tier contributes `curve × 0`, so it needs no special case:
    // a `continue` here would be an optimisation nothing could observe.
    rate += evaluateCurveById(curves, def.rateCurveId, plates) * moneyPrinterLevel(state, def.id);
  }
  return rate;
}

/** Run the presses for `dtMs` of design time. */
export function tickMoneyPrinting(
  state: GameState,
  content: Content,
  dtMs: number,
  curves: CurveRegistry,
): GameState {
  const rate = moneyPrintRate(state, content, curves);
  if (rate <= NONE || dtMs <= NONE) {
    return state;
  }
  const printed = (rate * dtMs) / MS_PER_SECOND;
  return {
    ...state,
    resources: withResource(state.resources, 'money', printed),
    stats: {
      ...state.stats,
      moneyPrinted: state.stats.moneyPrinted + printed,
      moneyEarned: state.stats.moneyEarned + printed,
    },
  };
}

export type MoneyPrinterRejection = 'unknown-target' | 'locked' | 'max-level';

export function moneyPrinterDef(content: Content, id: string): MoneyPrinterDef | undefined {
  return content.prestige.moneyPrinters.find((def) => def.id === id);
}

export function moneyPrinterAvailability(
  state: GameState,
  content: Content,
  moneyPrinterId: string,
): MoneyPrinterRejection | null {
  const def = moneyPrinterDef(content, moneyPrinterId);
  if (def === undefined) {
    return 'unknown-target';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  return moneyPrinterLevel(state, def.id) >= def.maxLevel ? 'max-level' : null;
}

export function nextMoneyPrinterCost(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  moneyPrinterId: string,
): Cost | null {
  const def = moneyPrinterDef(content, moneyPrinterId);
  if (def === undefined) {
    return null;
  }
  const cost = nextCost(curves, def, moneyPrinterLevel(state, def.id));
  // Plates are countable, like Parts: no fractions across the counter.
  return cost.resource === 'money' ? cost : { ...cost, amount: Math.ceil(cost.amount) };
}

export interface MoneyPrinterPurchase {
  readonly state: GameState;
  readonly def: MoneyPrinterDef;
  readonly cost: Cost;
  readonly level: number;
}

export function purchaseMoneyPrinter(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  moneyPrinterId: string,
): MoneyPrinterPurchase | null {
  const def = moneyPrinterDef(content, moneyPrinterId);
  const cost = nextMoneyPrinterCost(state, content, curves, moneyPrinterId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const level = moneyPrinterLevel(state, def.id) + ONE;
  const moneyPrinters: MoneyPrinterLedger = { ...paid.moneyPrinters, [def.id]: level };
  return { def, cost, level, state: { ...paid, moneyPrinters } };
}
