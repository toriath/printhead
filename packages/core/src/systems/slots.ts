import { indexById } from '../content/load.js';
import type { Content, SlotUnlockDef } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import type { GameState } from '../state/game-state.js';
import { emptySlot, slotIdAt } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { payCost } from './economy.js';
import { chosenFork } from './forks.js';
import { isPhaseReached } from './phases.js';
import { meetsRequirements } from './requirements.js';
import { isInstalled } from './upgrades.js';

/**
 * Config-slot progression (spec §4): **1 → 2 → 3 → 4, hard max.**
 *
 * The bays a player owns *are* `GameState.slots`, so "how many have I bought?"
 * is simply how far that array has grown past the starting count — no parallel
 * ledger to keep in step. Which bay comes next, what it costs and what gates it
 * all come from `content/slots.json`, in order, so the whole progression is a
 * data edit (spec §11).
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

export type SlotRejection =
  | 'unknown-target'
  | 'locked'
  | 'out-of-order'
  | 'max-level'
  | 'missing-prerequisite';

/** Bays already owned. Slots are only ever appended, never removed. */
export function ownedSlotCount(state: GameState): number {
  return state.slots.length;
}

/** How many of the `slots.json` unlocks have been bought. */
export function purchasedSlotCount(state: GameState, content: Content): number {
  return Math.max(ownedSlotCount(state) - content.start.slotCount, NONE);
}

/**
 * The hard maximum (spec §4). Derived rather than declared, so the cap and the
 * unlocks that reach it can never disagree.
 */
export function hardSlotMaximum(content: Content): number {
  return content.start.slotCount + content.slots.length;
}

/**
 * Bays the workshop may actually *use* right now. A fork can cap it below what
 * the player owns — that is what makes Goliath one machine (spec §5B).
 */
export function effectiveSlotCapacity(state: GameState, content: Content): number {
  const fork = chosenFork(state, content);
  const capped = fork?.slotCapacity ?? hardSlotMaximum(content);
  return Math.min(capped, Math.max(ownedSlotCount(state), ONE));
}

/** The next bay on the list, or `null` once every one has been bought. */
export function nextSlotUnlock(state: GameState, content: Content): SlotUnlockDef | null {
  return content.slots.at(purchasedSlotCount(state, content)) ?? null;
}

/**
 * Why this bay cannot be bought right now, or `null` when it can.
 *
 * Slots are bought **in order**: buying the fourth bay before the third is
 * `out-of-order` rather than a silent no-op, because content authors the
 * progression as a sequence and a caller that skips it has a bug.
 */
export function slotUnlockAvailability(
  state: GameState,
  content: Content,
  unlockId: string,
): SlotRejection | null {
  const def = indexById(content.slots).get(unlockId);
  if (def === undefined) {
    return 'unknown-target';
  }
  const next = nextSlotUnlock(state, content);
  if (next === null) {
    return 'max-level';
  }
  if (next.id !== def.id) {
    return 'out-of-order';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  for (const required of def.requiresUpgradeIds) {
    if (!isInstalled(state, required)) {
      return 'missing-prerequisite';
    }
  }
  // Slot 4 is prestige-gated through this list (spec §4): `plates >= 1` cannot
  // be satisfied until M5 mints the first Plate, so the bay stays shut.
  if (!meetsRequirements(state, content, def.requires)) {
    return 'locked';
  }
  return null;
}

/** Price of a bay: its position in the progression indexes the cost curve. */
export function nextSlotCost(
  content: Content,
  curves: CurveRegistry,
  unlockId: string,
): Cost | null {
  const index = content.slots.findIndex((def) => def.id === unlockId);
  const def = content.slots.at(index);
  if (def === undefined || index < NONE) {
    return null;
  }
  const cost = nextCost(curves, def, index);
  return cost.resource === 'parts' ? { ...cost, amount: Math.ceil(cost.amount) } : cost;
}

export interface SlotPurchase {
  readonly state: GameState;
  readonly def: SlotUnlockDef;
  readonly cost: Cost;
  readonly slotId: string;
}

export function purchaseSlot(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  unlockId: string,
): SlotPurchase | null {
  const def = indexById(content.slots).get(unlockId);
  const cost = nextSlotCost(content, curves, unlockId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const slotId = slotIdAt(content.start.slotIdPrefix, ownedSlotCount(state));
  return {
    def,
    cost,
    slotId,
    state: { ...paid, slots: [...paid.slots, emptySlot(slotId)] },
  };
}
