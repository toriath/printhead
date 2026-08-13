import type { Content, InflationMetric } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { evaluateCurveById } from '../curves/evaluate.js';
import { clamp } from '../math/scalar.js';
import type { GameState } from '../state/game-state.js';
import { isPhaseReached } from './phases.js';

/**
 * On-screen inflation (spec §6 phase 5: "the economy eats itself").
 *
 * The index is a curve read at a **reading of the simulation** — by default the
 * Money the Plates have printed — so the devaluation is *caused* by the player's
 * own presses rather than ticked up by a timer. Everything about it is content:
 * which reading drives it, how it is scaled, the shape of the curve, when it
 * switches on and how far it may run.
 *
 * It is applied in exactly two places, and both of them are prices:
 *
 * 1. every market quote (what a gram costs and what it fetches), and
 * 2. the money banked with a freshly printed Part or Product.
 *
 * Both sides move together, so the print economy stays roughly neutral in real
 * terms while the *numbers* run away — which is the joke phase 5 is making. The
 * money printers are the exception: their rate is nominal and fixed, so the
 * faster they run the less each printed pound is worth, and the Plates have to
 * find somewhere better to go. That somewhere is the Endgame Tree.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const NEUTRAL = 1;

/** Is the economy devaluing yet? False before `inflation.startPhaseId`. */
export function isInflating(state: GameState, content: Content): boolean {
  return isPhaseReached(
    content.pacing.phases,
    state.phaseId,
    content.endgame.inflation.startPhaseId,
  );
}

/** The run's own reading, before the content scale is applied. */
export function inflationReading(state: GameState, metric: InflationMetric): number {
  switch (metric) {
    case 'moneyPrinted':
      return state.stats.moneyPrinted;
    case 'moneyEarned':
      return state.stats.moneyEarned;
    case 'platesEarned':
      return state.stats.platesEarned;
  }
}

/** The reading the index curve is evaluated at, already scaled by content. */
export function inflationInput(state: GameState, content: Content): number {
  const { metric, inputScale } = content.endgame.inflation;
  return Math.max(inflationReading(state, metric), NONE) * inputScale;
}

/**
 * Today's price multiplier. Never below 1 — deflation is not a mechanic this
 * game has — and never above the content's ceiling, so a runaway curve cannot
 * produce a price the renderer has to apologise for.
 */
export function inflationMultiplier(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): number {
  if (!isInflating(state, content)) {
    return NEUTRAL;
  }
  const { curveId, maxMultiplier } = content.endgame.inflation;
  const index = evaluateCurveById(curves, curveId, inflationInput(state, content));
  return clamp(index, NEUTRAL, maxMultiplier);
}
