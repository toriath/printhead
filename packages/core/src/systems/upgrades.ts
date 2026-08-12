import { indexById } from '../content/load.js';
import type { Content, UpgradeDef, UpgradeEffect, UpgradeEffectType } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import type { GameState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { payCost } from './economy.js';
import { isPhaseReached } from './phases.js';

/**
 * The upgrade trees (spec §5) as one generic interpreter.
 *
 * A node is a list of `{ type, combine, value }` effects. Nothing here knows
 * what "heated bed" is: it folds every installed level into a modifier map and
 * the rest of the simulation asks that map for a number. Adding a machine node,
 * an automation licence or a farm perk is therefore a `upgrades.json` edit —
 * only a genuinely new *kind* of effect ever touches code (spec §11).
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const IDENTITY = 1;

export type ModifierMap = ReadonlyMap<UpgradeEffectType, number>;

export function installedLevel(state: GameState, upgradeId: string): number {
  return state.upgrades[upgradeId] ?? NONE;
}

export function isInstalled(state: GameState, upgradeId: string): boolean {
  return installedLevel(state, upgradeId) > NONE;
}

/** How many upgrade *levels* are installed in total — a phase-gate metric. */
export function countUpgrades(state: GameState): number {
  let total = NONE;
  for (const level of Object.values(state.upgrades)) {
    total += level;
  }
  return total;
}

function foldEffect(current: number | undefined, effect: UpgradeEffect, level: number): number {
  switch (effect.combine) {
    case 'multiply': {
      // Levels compound: a ×1.15 node at level 3 is ×1.15³.
      let total = current ?? IDENTITY;
      for (let step = NONE; step < level; step += IDENTITY) {
        total *= effect.value;
      }
      return total;
    }
    case 'add':
      return (current ?? NONE) + effect.value * level;
    case 'max':
      // "The best node wins" — levels do not stack, so the level is ignored.
      return Math.max(current ?? effect.value, effect.value);
  }
}

/** Fold every installed upgrade into one modifier map (spec §5). */
export function computeModifiers(state: GameState, content: Content): ModifierMap {
  const modifiers = new Map<UpgradeEffectType, number>();
  for (const def of content.upgrades) {
    const level = installedLevel(state, def.id);
    if (level <= NONE) {
      continue;
    }
    for (const effect of def.effects) {
      modifiers.set(effect.type, foldEffect(modifiers.get(effect.type), effect, level));
    }
  }
  return modifiers;
}

/**
 * Read a modifier, or `fallback` when nothing installed provides it. The
 * caller supplies the neutral value because only the caller knows it: ×1 for a
 * multiplier, +0 for a count, 0 for "you do not have this machine at all".
 */
export function modifierOf(
  modifiers: ModifierMap,
  type: UpgradeEffectType,
  fallback: number,
): number {
  return modifiers.get(type) ?? fallback;
}

export type UpgradeRejection = 'unknown-target' | 'locked' | 'max-level' | 'missing-prerequisite';

/** Why this node cannot be installed right now, or `null` when it can. */
export function upgradeAvailability(
  state: GameState,
  content: Content,
  upgradeId: string,
): UpgradeRejection | null {
  const def = indexById(content.upgrades).get(upgradeId);
  if (def === undefined) {
    return 'unknown-target';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  if (installedLevel(state, def.id) >= def.maxLevel) {
    return 'max-level';
  }
  for (const required of def.requiresUpgradeIds) {
    if (!isInstalled(state, required)) {
      return 'missing-prerequisite';
    }
  }
  return null;
}

export function nextUpgradeCost(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  upgradeId: string,
): Cost | null {
  const def = indexById(content.upgrades).get(upgradeId);
  if (def === undefined) {
    return null;
  }
  const cost = nextCost(curves, def, installedLevel(state, def.id));
  return cost.resource === 'parts' ? { ...cost, amount: Math.ceil(cost.amount) } : cost;
}

export interface UpgradePurchase {
  readonly state: GameState;
  readonly def: UpgradeDef;
  readonly cost: Cost;
  readonly level: number;
}

export function purchaseUpgrade(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  upgradeId: string,
): UpgradePurchase | null {
  const def = indexById(content.upgrades).get(upgradeId);
  const cost = nextUpgradeCost(state, content, curves, upgradeId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  const level = installedLevel(state, upgradeId) + IDENTITY;
  return {
    def,
    cost,
    level,
    state: { ...paid, upgrades: { ...paid.upgrades, [upgradeId]: level } },
  };
}

/**
 * Materials are gated by the machine tree as well as by the phase (spec §3):
 * PETG wants a heated bed, resin an SLA unit, metal a sintering head. The link
 * is `materials[].requiresUpgradeId`, so re-gating a material is a data edit.
 */
export function isMaterialAvailable(
  state: GameState,
  content: Content,
  materialId: string,
): boolean {
  const material = indexById(content.materials).get(materialId);
  if (material === undefined) {
    return false;
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, material.unlockPhaseId)) {
    return false;
  }
  return material.requiresUpgradeId === null || isInstalled(state, material.requiresUpgradeId);
}

export function availableMaterialIds(state: GameState, content: Content): readonly string[] {
  return content.materials
    .filter((material) => isMaterialAvailable(state, content, material.id))
    .map((material) => material.id);
}
