import type { PacingContent } from '../content/schema.js';

/**
 * THE one master variable (spec §8).
 *
 * `content/pacing.json` holds `targetHours`; the engine derives the pace scale
 * here — and only here — and exposes it exclusively as a wall-clock ⇄ sim-time
 * mapping. No other module may compute or read the scale: everything else asks
 * this mapping to convert time. `engine/pace.test.ts` enforces that rule by
 * scanning the source tree.
 *
 * `simDt = dt / paceScale`, so `targetHours: 4` (scale 0.5) makes the sim
 * advance twice as fast per wall-clock second, halving the game consistently.
 */
export interface PaceMapping {
  /** Wall-clock milliseconds → simulation milliseconds. */
  toSimDtMs(wallDtMs: number): number;
  /** Simulation milliseconds → wall-clock milliseconds. */
  toWallDtMs(simDtMs: number): number;
  /** Diagnostics only (editor/balance report). Never use to scale gameplay. */
  describe(): PaceDescription;
}

export interface PaceDescription {
  readonly targetHours: number;
  readonly baselineHours: number;
  readonly scale: number;
}

export function createPaceMapping(pacing: PacingContent): PaceMapping {
  const paceScale = pacing.targetHours / pacing.baselineHours;
  if (!Number.isFinite(paceScale) || paceScale <= 0) {
    throw new RangeError(`pace scale must be finite and positive, received ${paceScale}`);
  }
  return {
    toSimDtMs: (wallDtMs) => wallDtMs / paceScale,
    toWallDtMs: (simDtMs) => simDtMs * paceScale,
    describe: () => ({
      targetHours: pacing.targetHours,
      baselineHours: pacing.baselineHours,
      scale: paceScale,
    }),
  };
}
