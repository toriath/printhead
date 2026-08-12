import type { Content } from '../content/schema.js';
import type { Rng, RngSnapshot } from '../rng/mulberry32.js';
import { SAVE_SCHEMA_VERSION } from '../save/version.js';
import { firstPhaseId } from '../systems/phases.js';

/**
 * M0 keeps `GameState` intentionally tiny — the loop, resources and slots land
 * in M1. Every field added here must ship a save-schema bump, a migration and a
 * fixture test in the same commit (spec §19).
 */
export interface GameState {
  readonly saveVersion: number;
  readonly simTimeMs: number;
  readonly tickCount: number;
  readonly phaseId: string;
  readonly rng: RngSnapshot;
}

export interface ReduceContext {
  readonly content: Content;
  /** Injected clock — `core` never calls `Date.now` (spec §13). */
  readonly nowMs: number;
  /** Injected deterministic stream — `core` never calls `Math.random`. */
  readonly rng: Rng;
}

export interface InitialStateOptions {
  readonly seed: number;
}

export function createInitialState(content: Content, options: InitialStateOptions): GameState {
  return {
    saveVersion: SAVE_SCHEMA_VERSION,
    simTimeMs: 0,
    tickCount: 0,
    phaseId: firstPhaseId(content.pacing.phases),
    rng: { seed: options.seed, count: 0 },
  };
}
