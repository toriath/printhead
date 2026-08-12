import type { ScalarResourceKind } from '../content/schema.js';
import type { FilamentLedger, GameState, ResourceLedger } from '../state/game-state.js';

/**
 * The resource ledger (spec §2). Generic bookkeeping only: what a Part is worth
 * and what filament costs comes from `content/`, never from here.
 *
 * Two of the balances are **valued pools**: Parts and Scrap are fungible counts
 * that nevertheless carry a money value, because what they are worth depends on
 * the material they came out of (spec §2). Each pool keeps a single banked
 * total and every withdrawal takes its pro-rata share, which is what lets the
 * recycler and the sell button agree on what a pile is worth.
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

/** The two balances that carry a banked money value alongside their count. */
export type ValuedPool = 'parts' | 'scrap';

export interface PoolDraw {
  readonly count: number;
  readonly value: number;
}

export function poolValue(state: GameState, pool: ValuedPool): number {
  return pool === 'parts' ? state.partsValue : state.scrapValue;
}

/** Written out per pool rather than by computed key, so the type stays exact. */
function withPoolValue(state: GameState, pool: ValuedPool, value: number): GameState {
  return pool === 'parts' ? { ...state, partsValue: value } : { ...state, scrapValue: value };
}

/**
 * The average money value of one unit in the pool. Zero when it is empty, which
 * keeps `sell` and `spend` total on an empty inventory.
 */
export function unitValueOf(state: GameState, pool: ValuedPool): number {
  const count = state.resources[pool];
  return count > NONE ? poolValue(state, pool) / count : NONE;
}

/**
 * Take `requested` units out of a pool (clamped to stock), returning both the
 * count and the pro-rata share of the pool's value that leaves with them.
 */
export function drawPool(state: GameState, pool: ValuedPool, requested: number): PoolDraw {
  const available = state.resources[pool];
  const count = Math.min(Math.max(requested, NONE), available);
  if (count <= NONE) {
    return { count: NONE, value: NONE };
  }
  const banked = poolValue(state, pool);
  // Draw the whole pool exactly when it is emptied, so no value can be stranded.
  const value = count >= available ? banked : banked * (count / available);
  return { count, value };
}

/** Add freshly produced units and the money they are worth (spec §2). */
export function addPool(
  state: GameState,
  pool: ValuedPool,
  count: number,
  value: number,
): GameState {
  if (count <= NONE) {
    return state;
  }
  const banked = withPoolValue(state, pool, poolValue(state, pool) + value);
  return { ...banked, resources: withResource(banked.resources, pool, count) };
}

/** Remove units (sold, spent, recycled) together with their value share. */
export function removePool(state: GameState, pool: ValuedPool, draw: PoolDraw): GameState {
  if (draw.count <= NONE) {
    return state;
  }
  const remaining = state.resources[pool] - draw.count;
  const banked = withPoolValue(
    state,
    pool,
    remaining > NONE ? poolValue(state, pool) - draw.value : NONE,
  );
  return { ...banked, resources: withResource(banked.resources, pool, -draw.count) };
}

// --- named wrappers ---------------------------------------------------------
// The pools read better at the call site under their own names, and keeping the
// names means a future third pool cannot silently change what `drawParts` does.

export const unitPartValue = (state: GameState): number => unitValueOf(state, 'parts');
export const drawParts = (state: GameState, requested: number): PoolDraw =>
  drawPool(state, 'parts', requested);
export const addParts = (state: GameState, count: number, value: number): GameState =>
  addPool(state, 'parts', count, value);
export const removeParts = (state: GameState, draw: PoolDraw): GameState =>
  removePool(state, 'parts', draw);

export const unitScrapValue = (state: GameState): number => unitValueOf(state, 'scrap');
export const drawScrap = (state: GameState, requested: number): PoolDraw =>
  drawPool(state, 'scrap', requested);
export const addScrap = (state: GameState, grams: number, value: number): GameState =>
  addPool(state, 'scrap', grams, value);
export const removeScrap = (state: GameState, draw: PoolDraw): GameState =>
  removePool(state, 'scrap', draw);
