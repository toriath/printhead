import { indexById } from '../content/load.js';
import type { AutomationDef, Content } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import type { AutomationSlotState, GameState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { payCost, sellPartsFrom } from './economy.js';
import { recycleScrapInto } from './failure.js';
import { purchaseFilament, quoteFor, sellFilamentToMarket } from './market.js';
import { isPhaseReached } from './phases.js';
import { resolveSlotConfig } from './printing.js';
import { computeModifiers, isInstalled } from './upgrades.js';

/**
 * Automation (spec §5C). The design brief is "introduce friction, then sell its
 * removal", so every automation does something the player was already doing by
 * hand — and does it through exactly the same system functions, never through a
 * shortcut of its own. An auto-seller cannot sell parts the sell button would
 * refuse.
 *
 * Which job a def does is `behavior`, a discriminated union in content: the
 * Strategy pattern of spec §15, selected by data. Adding "auto-changeover" in
 * M4 is a new variant plus one case here.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

export function automationStateOf(state: GameState, id: string): AutomationSlotState | undefined {
  return state.automation[id];
}

export function automationLevel(state: GameState, id: string): number {
  return state.automation[id]?.level ?? NONE;
}

export function isAutomationActive(state: GameState, id: string): boolean {
  const owned = state.automation[id];
  return owned !== undefined && owned.level > NONE && owned.enabled;
}

/** How many automations are installed — a phase-gate metric (spec §6). */
export function countAutomations(state: GameState): number {
  let total = NONE;
  for (const owned of Object.values(state.automation)) {
    total += owned.level;
  }
  return total;
}

export type AutomationRejection =
  | 'unknown-target'
  | 'locked'
  | 'max-level'
  | 'missing-prerequisite';

export function automationAvailability(
  state: GameState,
  content: Content,
  automationId: string,
): AutomationRejection | null {
  const def = indexById(content.automation).get(automationId);
  if (def === undefined) {
    return 'unknown-target';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  if (automationLevel(state, automationId) >= def.maxLevel) {
    return 'max-level';
  }
  for (const required of def.requiresUpgradeIds) {
    if (!isInstalled(state, required)) {
      return 'missing-prerequisite';
    }
  }
  return null;
}

export function nextAutomationCost(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  automationId: string,
): Cost | null {
  const def = indexById(content.automation).get(automationId);
  if (def === undefined) {
    return null;
  }
  const cost = nextCost(curves, def, automationLevel(state, automationId));
  return cost.resource === 'parts' ? { ...cost, amount: Math.ceil(cost.amount) } : cost;
}

export interface AutomationPurchase {
  readonly state: GameState;
  readonly def: AutomationDef;
  readonly cost: Cost;
  readonly level: number;
}

export function purchaseAutomation(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  automationId: string,
): AutomationPurchase | null {
  const def = indexById(content.automation).get(automationId);
  const cost = nextAutomationCost(state, content, curves, automationId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const level = automationLevel(state, automationId) + ONE;
  const installed: AutomationSlotState = {
    level,
    enabled: true,
    threshold: def.defaultThreshold,
    // Fires on its first full interval, not the instant it is bolted on.
    cooldownMs: def.intervalDesignSeconds * MS_PER_SECOND,
  };
  return {
    def,
    cost,
    level,
    state: { ...paid, automation: { ...paid.automation, [automationId]: installed } },
  };
}

/** Player edits to an installed automation: the on/off switch and its trigger. */
export function configureAutomation(
  state: GameState,
  automationId: string,
  changes: { readonly enabled?: boolean; readonly threshold?: number },
): GameState | null {
  const owned = state.automation[automationId];
  if (owned === undefined || owned.level <= NONE) {
    return null;
  }
  const threshold = changes.threshold;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < NONE)) {
    return null;
  }
  const next: AutomationSlotState = {
    ...owned,
    enabled: changes.enabled ?? owned.enabled,
    threshold: threshold ?? owned.threshold,
  };
  return { ...state, automation: { ...state.automation, [automationId]: next } };
}

// --- behaviours -------------------------------------------------------------

/**
 * Sell the *surplus* above the player's threshold, keeping the rest.
 *
 * Selling the whole pile would be the obvious reading of "auto-sell at 40", and
 * it is a trap: Parts are the currency of capacity (spec §1), so an auto-seller
 * that empties the tin makes it impossible to ever save up for a printer. The
 * threshold is therefore the float the machine leaves behind.
 */
function fireSellParts(
  state: GameState,
  threshold: number,
  emit: EventSink | undefined,
): GameState {
  const surplus = state.resources.parts - threshold;
  if (surplus <= NONE) {
    return state;
  }
  const sale = sellPartsFrom(state, surplus);
  if (sale === null) {
    return state;
  }
  emit?.({
    type: 'PART_SOLD',
    simTimeMs: state.simTimeMs,
    parts: sale.parts,
    money: sale.money,
  });
  return sale.state;
}

/**
 * Keep every loaded slot's material topped up to the threshold, out of whatever
 * is above the money reserve. The reserve is what stops the auto-buyer from
 * spending the printer fund on filament nobody asked for.
 */
function fireBuyFilament(
  state: GameState,
  content: Content,
  threshold: number,
  moneyReserve: number,
  emit: EventSink | undefined,
): GameState {
  let next = state;
  for (const slot of state.slots) {
    const config = resolveSlotConfig(content, slot);
    if (config === null) {
      continue;
    }
    const stock = next.filamentGrams[config.material.id] ?? NONE;
    const wanted = threshold - stock;
    if (wanted <= NONE) {
      continue;
    }
    const quote = quoteFor(next, content, config.material.id);
    if (quote === null || quote.buyPerGram <= NONE) {
      continue;
    }
    const budget = next.resources.money - moneyReserve;
    if (budget <= NONE) {
      continue;
    }
    const grams = Math.floor(Math.min(wanted, budget / quote.buyPerGram, quote.stockGrams));
    if (grams <= NONE) {
      continue;
    }
    const bought = purchaseFilament(next, content, config.material.id, grams);
    if (bought === null) {
      continue;
    }
    emit?.({
      type: 'FILAMENT_PURCHASED',
      simTimeMs: next.simTimeMs,
      materialId: config.material.id,
      grams: bought.grams,
      money: bought.money,
    });
    next = bought.state;
  }
  return next;
}

/**
 * Auto-trading (spec §5C): buy a fixed parcel when a material is cheap, sell it
 * back when it is dear. It trades against the same market model the player
 * does, spread included, so it is a slow earner rather than a printing press.
 */
function fireTradeFilament(
  state: GameState,
  content: Content,
  def: Extract<AutomationDef, { behavior: 'trade-filament' }>,
  parcelGrams: number,
  emit: EventSink | undefined,
): GameState {
  let next = state;
  for (const listing of content.market.listings) {
    if (!isPhaseReached(content.pacing.phases, next.phaseId, listing.unlockPhaseId)) {
      continue;
    }
    const quote = quoteFor(next, content, listing.materialId);
    if (quote === null || !quote.tradeable) {
      continue;
    }
    const held = next.filamentGrams[listing.materialId] ?? NONE;
    if (quote.multiplier <= def.buyBelowMultiplier && held + parcelGrams <= def.maxHoldingGrams) {
      const grams = Math.floor(Math.min(parcelGrams, quote.stockGrams));
      const bought =
        grams > NONE ? purchaseFilament(next, content, listing.materialId, grams) : null;
      if (bought !== null) {
        emit?.({
          type: 'FILAMENT_PURCHASED',
          simTimeMs: next.simTimeMs,
          materialId: listing.materialId,
          grams: bought.grams,
          money: bought.money,
        });
        next = bought.state;
      }
      continue;
    }
    if (quote.multiplier >= def.sellAboveMultiplier && held >= parcelGrams) {
      const sold = sellFilamentToMarket(next, content, listing.materialId, parcelGrams);
      if (sold !== null) {
        emit?.({
          type: 'FILAMENT_SOLD',
          simTimeMs: next.simTimeMs,
          materialId: listing.materialId,
          grams: sold.grams,
          money: sold.money,
          pricePerGram: sold.pricePerGram,
        });
        next = sold.state;
      }
    }
  }
  return next;
}

/**
 * Recycle the whole Scrap pile once it reaches the threshold, into whatever the
 * first bay is loaded with (an empty bay: the first material), which is the
 * same target the recycler panel quotes. No recycler installed, nothing to do.
 */
function fireRecycleScrap(
  state: GameState,
  content: Content,
  threshold: number,
  emit: EventSink | undefined,
): GameState {
  if (state.resources.scrap < threshold || state.resources.scrap <= NONE) {
    return state;
  }
  const slot = state.slots.at(NONE);
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  const target = config?.material ?? content.materials.at(NONE);
  if (target === undefined) {
    return state;
  }
  const result = recycleScrapInto(
    state,
    content,
    computeModifiers(state, content),
    target.id,
    null,
  );
  if (typeof result === 'string') {
    return state;
  }
  emit?.({
    type: 'SCRAP_RECYCLED',
    simTimeMs: state.simTimeMs,
    materialId: result.materialId,
    scrapGrams: result.scrapGrams,
    filamentGrams: result.filamentGrams,
  });
  return result.state;
}

function fire(
  state: GameState,
  content: Content,
  def: AutomationDef,
  owned: AutomationSlotState,
  emit: EventSink | undefined,
): GameState {
  switch (def.behavior) {
    case 'sell-parts':
      return fireSellParts(state, owned.threshold, emit);
    case 'buy-filament':
      return fireBuyFilament(state, content, owned.threshold, def.moneyReserve, emit);
    case 'trade-filament':
      return fireTradeFilament(state, content, def, owned.threshold, emit);
    case 'recycle-scrap':
      return fireRecycleScrap(state, content, owned.threshold, emit);
    case 'auto-changeover':
      /*
       * The rota is turned by the print loop, not by this timer.
       *
       * A slot that auto-restarts re-arms the instant a batch lands, so an
       * interval-driven changeover would almost never find an idle bay and
       * would have to interrupt a run to do anything at all — abandoning
       * filament the player already paid for, on a clock they did not set.
       * Rotating at the natural boundary (`printing.ts`, when a batch
       * completes) is both cheaper and what a queue means. This automation's
       * job is to *permit* that rotation and to hold its stock floor, which
       * `systems/queue.ts` reads straight off the installed level.
       */
      return state;
  }
}

/**
 * Advance every installed automation's timer and fire the ones that come due.
 * Defs run in content order so the sequence is reproducible, and a firing that
 * overshoots its interval carries the overshoot forward — the same rule the
 * print loop follows, so automation stays exactly time-additive.
 */
export function tickAutomation(
  state: GameState,
  content: Content,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  let next = state;
  for (const def of content.automation) {
    const owned = next.automation[def.id];
    if (owned === undefined || owned.level <= NONE) {
      continue;
    }
    let cooldownMs = owned.cooldownMs - dtMs;
    const intervalMs = def.intervalDesignSeconds * MS_PER_SECOND;
    let fired = false;
    while (cooldownMs <= NONE) {
      if (owned.enabled) {
        const before = next;
        next = fire(next, content, def, owned, emit);
        if (next !== before) {
          fired = true;
        }
      }
      cooldownMs += intervalMs;
    }
    if (fired) {
      emit?.({
        type: 'AUTOMATION_FIRED',
        simTimeMs: next.simTimeMs,
        automationId: def.id,
        behavior: def.behavior,
      });
    }
    const current = next.automation[def.id] ?? owned;
    next = { ...next, automation: { ...next.automation, [def.id]: { ...current, cooldownMs } } };
  }
  return next;
}
