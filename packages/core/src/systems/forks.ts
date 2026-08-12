import { indexById } from '../content/load.js';
import type { Content, ForkDef } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import type { GameState, SlotState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { payCost } from './economy.js';
import { isPhaseReached } from './phases.js';
import { meetsRequirements } from './requirements.js';
import { isInstalled } from './upgrades.js';

/**
 * The per-run Farm/Goliath fork (spec §5B).
 *
 * **Mutually exclusive per run** is enforced by shape, not by a rule: there is
 * one `forkId` on the state and the reducer only ever writes it while it is
 * `null`. Nothing here knows which branch is "the big one" — a fork that caps
 * `slotCapacity` at one *is* the giant printer, and the renderer picks its
 * drawing from the def's `visual` field.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const FIRST = 0;

export type ForkRejection =
  | 'unknown-target'
  | 'locked'
  | 'missing-prerequisite'
  | 'max-level'
  | 'insufficient-resources';

export function chosenFork(state: GameState, content: Content): ForkDef | null {
  return state.forkId === null ? null : (indexById(content.forks).get(state.forkId) ?? null);
}

export function isForkChosen(state: GameState): boolean {
  return state.forkId !== null;
}

/** Why this branch cannot be taken right now, or `null` when it can. */
export function forkAvailability(
  state: GameState,
  content: Content,
  forkId: string,
): ForkRejection | null {
  const def = indexById(content.forks).get(forkId);
  if (def === undefined) {
    return 'unknown-target';
  }
  if (isForkChosen(state)) {
    // The commitment has already been made; a run gets exactly one.
    return 'max-level';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  for (const required of def.requiresUpgradeIds) {
    if (!isInstalled(state, required)) {
      return 'missing-prerequisite';
    }
  }
  return meetsRequirements(state, content, def.requires) ? null : 'locked';
}

export function forkCost(content: Content, curves: CurveRegistry, forkId: string): Cost | null {
  const def = indexById(content.forks).get(forkId);
  if (def === undefined) {
    return null;
  }
  const cost = nextCost(curves, def, FIRST);
  return cost.resource === 'parts' ? { ...cost, amount: Math.ceil(cost.amount) } : cost;
}

/**
 * Fold the fleet down into the bays a branch allows.
 *
 * Committing to Goliath is a *melt-down*, not a toggle: the machines in the
 * surplus bays are carried into the first one and those bays are stripped back
 * to bare outlines. Whatever they had in flight is abandoned — its filament was
 * spent when the batch started — which is the price of the commitment, and the
 * reason the choice is worth agonising over.
 */
export function consolidateSlots(
  slots: readonly SlotState[],
  capacity: number,
): readonly SlotState[] {
  if (slots.length <= capacity) {
    return slots;
  }
  const kept = slots.slice(FIRST, capacity);
  const surplus = slots.slice(capacity);
  const absorbed = surplus.reduce((total, slot) => total + slot.printerCount, NONE);
  const first = kept.at(FIRST);
  if (first === undefined) {
    return slots;
  }
  return [
    { ...first, printerCount: first.printerCount + absorbed },
    ...kept.slice(FIRST + 1),
    ...surplus.map((slot) => ({
      ...slot,
      materialId: null,
      objectId: null,
      printerCount: NONE,
      autoRestart: false,
      run: null,
      changeoverMs: NONE,
      queue: [],
      queueIndex: NONE,
      queueBatches: NONE,
    })),
  ];
}

export interface ForkChoice {
  readonly state: GameState;
  readonly def: ForkDef;
  readonly cost: Cost;
}

export function commitFork(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  forkId: string,
): ForkChoice | null {
  const def = indexById(content.forks).get(forkId);
  const cost = forkCost(content, curves, forkId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const slots =
    def.slotCapacity === null ? paid.slots : consolidateSlots(paid.slots, def.slotCapacity);
  return { def, cost, state: { ...paid, forkId: def.id, slots } };
}
