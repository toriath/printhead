import type { ScalarResourceKind } from '../content/schema.js';
import type { FilamentLedger, GameState, ResourceLedger } from '../state/game-state.js';

/**
 * The resource ledger (spec §2). Generic bookkeeping only: what a Part is worth
 * and what filament costs comes from `content/`, never from here.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11) —
 * CI enforces this with `pnpm literals:check`.
 */
const NONE = 0;

export function filamentOf(state: GameState, materialId: string): number {
  return state.filamentGrams[materialId] ?? NONE;
}

export function withResource(
  resources: ResourceLedger,
  kind: ScalarResourceKind,
  amount: number,
): ResourceLedger {
  return { ...resources, [kind]: resources[kind] + amount };
}

export function withFilament(
  filament: FilamentLedger,
  materialId: string,
  grams: number,
): FilamentLedger {
  return { ...filament, [materialId]: (filament[materialId] ?? NONE) + grams };
}

/**
 * The average money value of one Part in stock. Zero when the pool is empty,
 * which keeps `sell` and `spend` total on an empty inventory.
 */
export function unitPartValue(state: GameState): number {
  const count = state.resources.parts;
  return count > NONE ? state.partsValue / count : NONE;
}

export interface PartsDraw {
  readonly count: number;
  readonly value: number;
}

/**
 * Take `requested` parts out of the pool (clamped to stock), returning both the
 * count and the pro-rata share of the pool's value that leaves with them.
 */
export function drawParts(state: GameState, requested: number): PartsDraw {
  const available = state.resources.parts;
  const count = Math.min(Math.max(requested, NONE), available);
  if (count <= NONE) {
    return { count: NONE, value: NONE };
  }
  // Draw the whole pool exactly when it is emptied, so no value can be stranded.
  const value = count >= available ? state.partsValue : state.partsValue * (count / available);
  return { count, value };
}

/** Add freshly printed parts and the money they are worth (spec §2). */
export function addParts(state: GameState, count: number, value: number): GameState {
  if (count <= NONE) {
    return state;
  }
  return {
    ...state,
    resources: withResource(state.resources, 'parts', count),
    partsValue: state.partsValue + value,
  };
}

/** Remove parts (sold, or spent on a printer) together with their value share. */
export function removeParts(state: GameState, draw: PartsDraw): GameState {
  if (draw.count <= NONE) {
    return state;
  }
  const remaining = state.resources.parts - draw.count;
  return {
    ...state,
    resources: withResource(state.resources, 'parts', -draw.count),
    partsValue: remaining > NONE ? state.partsValue - draw.value : NONE,
  };
}
