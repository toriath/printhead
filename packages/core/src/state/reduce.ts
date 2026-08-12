import { nextPhaseId } from '../systems/phases.js';
import type { Action } from './actions.js';
import type { GameState, ReduceContext } from './game-state.js';

/**
 * The single pure reducer (spec §15). No I/O, no clock, no randomness beyond
 * what `ctx` injects; identical `(state, action, ctx)` always yields an
 * identical next state.
 */
export function reduce(state: GameState, action: Action, ctx: ReduceContext): GameState {
  switch (action.type) {
    case 'TICK': {
      if (!Number.isFinite(action.simDtMs) || action.simDtMs < 0) {
        throw new RangeError(`TICK simDtMs must be non-negative, received ${action.simDtMs}`);
      }
      return {
        ...state,
        simTimeMs: state.simTimeMs + action.simDtMs,
        tickCount: state.tickCount + 1,
      };
    }
    case 'ADVANCE_PHASE': {
      const next = nextPhaseId(ctx.content.pacing.phases, state.phaseId);
      return next === null ? state : { ...state, phaseId: next };
    }
  }
}
