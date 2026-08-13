import { indexById } from '../content/load.js';
import type { Content, DesignDef } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { evaluateCurveById } from '../curves/evaluate.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import type { DesignLedger, DesignState, GameState } from '../state/game-state.js';
import { type Cost, nextCost } from './cost.js';
import { payCost } from './economy.js';
import { isPhaseReached } from './phases.js';
import { type ModifierMap, isMaterialAvailable, modifierOf } from './upgrades.js';

/**
 * The Design Studio (spec §5D).
 *
 * A Design is drafted once, occupies the bench for `designDesignMinutes`, and
 * is then owned forever — it is the only thing in the game a melt-down does not
 * take away (spec §2). Printing a Design makes **Products** instead of Parts,
 * and every batch printed levels the design up, so the studio rewards
 * commitment to one object rather than breadth.
 *
 * Nothing here knows what the Money Plate is: the capstone is whichever design
 * `prestige.requiredDesignId` names, so re-pointing the prestige gate at
 * another design is a JSON edit (spec §11).
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

export function designState(state: GameState, designId: string): DesignState | null {
  return state.designs[designId] ?? null;
}

export function hasDesign(state: GameState, designId: string): boolean {
  return designState(state, designId) !== null;
}

/** Designs owned. This is the count `resources.designs` mirrors for the gates. */
export function countDesigns(state: GameState): number {
  return Object.keys(state.designs).length;
}

/** Total levels across every design — how much the studio has been *used*. */
export function countDesignLevels(state: GameState): number {
  let total = NONE;
  for (const design of Object.values(state.designs)) {
    total += design.level;
  }
  return total;
}

/** Has the capstone (spec §5D: the Money Plate) been drafted? Prestige waits on it. */
export function hasCapstoneDesign(state: GameState, content: Content): boolean {
  return hasDesign(state, content.prestige.requiredDesignId);
}

/** Design slots the studio has right now: the base plus whatever the tree adds. */
export function designSlotCount(content: Content, modifiers: ModifierMap): number {
  return content.start.designSlots + modifierOf(modifiers, 'designSlots', NONE);
}

export function freeDesignSlots(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
): number {
  return Math.max(designSlotCount(content, modifiers) - countDesigns(state), NONE);
}

/**
 * What one Product of this design is worth. The level multiplier comes from the
 * def's own curve read at `level - 1`, so level 1 is the authored base value
 * and every level after it is pure content shaping (spec §11).
 */
export function productValueOf(
  def: DesignDef,
  curves: CurveRegistry,
  level: number,
  modifiers: ModifierMap,
): number {
  const multiplier = evaluateCurveById(curves, def.levelValueCurveId, Math.max(level - ONE, NONE));
  return def.baseProductValue * multiplier * modifierOf(modifiers, 'productValueMultiplier', ONE);
}

export function nextDesignCost(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  designId: string,
): Cost | null {
  const def = indexById(content.designs).get(designId);
  if (def === undefined) {
    return null;
  }
  // Priced by how many designs the studio has already produced, so the second
  // draft is dearer than the first however they are ordered in the file.
  const cost = nextCost(curves, def, countDesigns(state));
  return cost.resource === 'money' ? cost : { ...cost, amount: Math.ceil(cost.amount) };
}

export type DesignRejection =
  | 'unknown-target'
  | 'locked'
  | 'already-owned'
  | 'slot-busy'
  | 'slot-full'
  | 'missing-prerequisite';

/**
 * Why the studio cannot start this draft, or `null` when it can.
 *
 * `missing-prerequisite` is the resin gate of spec §3 — the design names the
 * material it needs and the machine tree decides whether the workshop has it —
 * and `slot-full` is the design-slot limit, which is what stops the player from
 * simply owning every design.
 */
export function designAvailability(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
  designId: string,
): DesignRejection | null {
  const def = indexById(content.designs).get(designId);
  if (def === undefined) {
    return 'unknown-target';
  }
  if (!isPhaseReached(content.pacing.phases, state.phaseId, def.unlockPhaseId)) {
    return 'locked';
  }
  if (hasDesign(state, designId)) {
    // A Design is drafted once and then levelled by printing it, so "you
    // already have this one" is its own answer, not a level cap.
    return 'already-owned';
  }
  if (state.studio !== null) {
    return 'slot-busy';
  }
  if (!isMaterialAvailable(state, content, def.requiredMaterialId)) {
    return 'missing-prerequisite';
  }
  if (freeDesignSlots(state, content, modifiers) <= NONE) {
    return 'slot-full';
  }
  return null;
}

export interface DesignDraft {
  readonly state: GameState;
  readonly def: DesignDef;
  readonly cost: Cost;
}

/** Pay for a draft and put it on the bench; the tick finishes it. */
export function startDesignDraft(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  designId: string,
): DesignDraft | null {
  const def = indexById(content.designs).get(designId);
  const cost = nextDesignCost(state, content, curves, designId);
  if (def === undefined || cost === null) {
    return null;
  }
  const paid = payCost(state, cost);
  if (paid === null) {
    return null;
  }
  return {
    def,
    cost,
    state: {
      ...paid,
      studio: { designId, remainingMs: def.designDesignMinutes * MS_PER_MINUTE },
    },
  };
}

export interface DraftCompletion {
  readonly state: GameState;
  readonly designId: string;
}

/**
 * Burn `dtMs` off the bench. A finished draft becomes a level-1 Design and
 * bumps the `designs` balance, which is the reading the phase gates use.
 */
export function tickStudio(state: GameState, dtMs: number): DraftCompletion | GameState {
  const project = state.studio;
  if (project === null) {
    return state;
  }
  if (project.remainingMs > dtMs) {
    return { ...state, studio: { ...project, remainingMs: project.remainingMs - dtMs } };
  }
  const designs: DesignLedger = {
    ...state.designs,
    [project.designId]: { level: ONE, printsOnLevel: NONE },
  };
  return {
    designId: project.designId,
    state: {
      ...state,
      studio: null,
      designs,
      resources: { ...state.resources, designs: Object.keys(designs).length },
    },
  };
}

export interface DesignLevelUp {
  readonly designId: string;
  readonly level: number;
}

export interface DesignProgress {
  readonly designs: DesignLedger;
  readonly levelUp: DesignLevelUp | null;
}

/**
 * Credit `prints` successful prints to a design (spec §5D: "designs level up
 * per printed batch"). Progress is counted in prints rather than batches so a
 * rack of eight machines advances a design eight times as fast as one machine
 * does — the level is a measure of how much of the thing you have made.
 */
export function creditDesignPrints(
  designs: DesignLedger,
  def: DesignDef,
  prints: number,
): DesignProgress {
  const current = designs[def.id];
  if (current === undefined || prints <= NONE) {
    return { designs, levelUp: null };
  }
  if (current.level >= def.maxLevel) {
    return { designs, levelUp: null };
  }
  let level = current.level;
  let onLevel = current.printsOnLevel + prints;
  while (onLevel >= def.printsPerLevel && level < def.maxLevel) {
    onLevel -= def.printsPerLevel;
    level += ONE;
  }
  const capped = level >= def.maxLevel ? NONE : onLevel;
  return {
    designs: { ...designs, [def.id]: { level, printsOnLevel: capped } },
    levelUp: level > current.level ? { designId: def.id, level } : null,
  };
}
