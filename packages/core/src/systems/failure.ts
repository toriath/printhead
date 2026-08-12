import { indexById } from '../content/load.js';
import type { Content, FailureContent, MaterialDef } from '../content/schema.js';
import type { GameState } from '../state/game-state.js';
import { addScrap, drawScrap, removeScrap, withFilament } from './resources.js';
import { type ModifierMap, isInstalled, modifierOf } from './upgrades.js';

/**
 * Failure and the consolation loop (spec §7.1, §2).
 *
 * The failure model is a **deterministic pity timer**, not a dice roll: each
 * print adds the loaded material's charge to the slot, and when the charge
 * crosses the threshold that print fails and the charge resets. Two runs from
 * the same state therefore fail in exactly the same places — which is what
 * makes a balance run reproducible and a bug reportable as `(seed, actionLog)`.
 *
 * A failed print yields Scrap instead of Parts. The recycler turns Scrap back
 * into filament at `yieldFraction` of the *value* it carried in — never grams
 * into grams of a dearer material — so the loop can only ever lose value
 * (spec §13, "recycler conserves").
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

/** Charge one print in this material adds, after machine and upgrade effects. */
export function chargePerPrint(
  material: MaterialDef,
  printerFailureMultiplier: number,
  modifiers: ModifierMap,
): number {
  return (
    material.failureChargePerPrint *
    printerFailureMultiplier *
    modifierOf(modifiers, 'failureChargeMultiplier', ONE)
  );
}

export interface BatchFailures {
  readonly failed: number;
  readonly succeeded: number;
  readonly charge: number;
}

/**
 * Walk a batch print by print, accumulating charge. Deliberately a loop rather
 * than a closed form: the batch size is the slot's printer count, and the
 * whole point of a pity timer is that the *order* of failures is defined.
 */
export function resolveBatchFailures(
  failure: FailureContent,
  charge: number,
  batch: number,
  perPrint: number,
): BatchFailures {
  if (failure.model.strategy === 'never' || perPrint <= NONE) {
    return { failed: NONE, succeeded: batch, charge };
  }
  const { chargeThreshold, carryFraction } = failure.model;
  let current = charge;
  let failed = NONE;
  for (let print = NONE; print < batch; print += ONE) {
    current += perPrint;
    if (current >= chargeThreshold) {
      failed += ONE;
      current = current - chargeThreshold + chargeThreshold * carryFraction;
    }
  }
  return { failed, succeeded: batch - failed, charge: current };
}

export interface ScrapYield {
  readonly grams: number;
  readonly value: number;
}

/**
 * What a failed print leaves behind. Grams come from the material's recovery
 * fraction; the value banked with them is what that filament cost at the shelf
 * price, which is the ceiling the recycler is later allowed to hand back.
 */
export function scrapFromFailure(material: MaterialDef, wastedGrams: number): ScrapYield {
  const grams = wastedGrams * material.scrapRecoveryFraction;
  return { grams, value: grams * material.costPerGram };
}

export function recyclerYield(modifiers: ModifierMap): number {
  return modifierOf(modifiers, 'recyclerYieldFraction', NONE);
}

export function hasRecycler(state: GameState, content: Content): boolean {
  return isInstalled(state, content.failure.recycler.requiresUpgradeId);
}

export type RecycleRejection = 'unknown-target' | 'no-recycler' | 'nothing-to-do';

export interface RecycleResult {
  readonly state: GameState;
  readonly scrapGrams: number;
  readonly filamentGrams: number;
  readonly materialId: string;
}

/**
 * Scrap → filament. The output is capped by *value*: `drawnValue × yield`
 * divided by what a gram of the target material is worth. Recycling PLA swarf
 * into resin therefore hands back a pittance of resin rather than minting it.
 */
export function recycleScrapInto(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
  materialId: string,
  requestedGrams: number | null,
): RecycleResult | RecycleRejection {
  const material = indexById(content.materials).get(materialId);
  if (material === undefined || material.costPerGram <= NONE) {
    return 'unknown-target';
  }
  if (!hasRecycler(state, content)) {
    return 'no-recycler';
  }
  const yieldFraction = recyclerYield(modifiers);
  if (yieldFraction <= NONE) {
    return 'no-recycler';
  }
  const draw = drawScrap(state, requestedGrams ?? state.resources.scrap);
  if (draw.count <= NONE || draw.value <= NONE) {
    return 'nothing-to-do';
  }
  const grams = (draw.value * yieldFraction) / material.costPerGram;
  const drained = removeScrap(state, draw);
  return {
    materialId,
    scrapGrams: draw.count,
    filamentGrams: grams,
    state: {
      ...drained,
      filamentGrams: withFilament(drained.filamentGrams, materialId, grams),
      stats: {
        ...drained.stats,
        scrapRecycledGrams: drained.stats.scrapRecycledGrams + draw.count,
      },
    },
  };
}

/** Bank the scrap a failed batch produced. */
export function bankScrap(state: GameState, produced: ScrapYield): GameState {
  if (produced.grams <= NONE) {
    return state;
  }
  const banked = addScrap(state, produced.grams, produced.value);
  return {
    ...banked,
    stats: {
      ...banked.stats,
      scrapProducedGrams: banked.stats.scrapProducedGrams + produced.grams,
    },
  };
}
