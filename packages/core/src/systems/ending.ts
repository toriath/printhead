import type { Content } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { clamp } from '../math/scalar.js';
import type { GameState } from '../state/game-state.js';

/**
 * The ending sequence (spec §6 phase 6). Kept apart from the rest of the
 * endgame on purpose: it is a pure reading of the clock and of content, with no
 * dependency on the fork, the rack or the economy, which is what lets the phase
 * FSM's own requirement interpreter ask it whether the credits have finished
 * without dragging half the simulation in behind it.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

/**
 * The ending is three stages and then the post-game: the numbers fade to ∞, the
 * museum puts printer #1 under glass, the credits print out. Each stage is a
 * duration in `endgame.ending`, and the stage is a pure function of how long
 * ago the Fabricator finished — no script, no timers, and a save reloaded
 * mid-credits resumes exactly where it was.
 */
export type EndingStage = 'none' | 'numbers' | 'museum' | 'credits' | 'complete';

export function endingElapsedMs(state: GameState): number {
  const finished = state.fabricator.completedAtMs;
  return finished === null ? NONE : Math.max(state.simTimeMs - finished, NONE);
}

export function endingTotalMs(content: Content): number {
  const { numbersDesignSeconds, museumDesignSeconds, creditsDesignSeconds } =
    content.endgame.ending;
  return (numbersDesignSeconds + museumDesignSeconds + creditsDesignSeconds) * MS_PER_SECOND;
}

export function endingStage(state: GameState, content: Content): EndingStage {
  if (state.fabricator.completedAtMs === null) {
    return 'none';
  }
  const { numbersDesignSeconds, museumDesignSeconds } = content.endgame.ending;
  const elapsed = endingElapsedMs(state);
  if (elapsed < numbersDesignSeconds * MS_PER_SECOND) {
    return 'numbers';
  }
  if (elapsed < (numbersDesignSeconds + museumDesignSeconds) * MS_PER_SECOND) {
    return 'museum';
  }
  return elapsed < endingTotalMs(content) ? 'credits' : 'complete';
}

/** 0..1 through the whole sequence — what the renderer fades on. */
export function endingProgress(state: GameState, content: Content): number {
  const total = endingTotalMs(content);
  return total <= NONE ? NONE : clamp(endingElapsedMs(state) / total, NONE, ONE);
}

/** The FSM's last gate: the credits have finished printing (spec §15). */
export function isEndingComplete(state: GameState, content: Content): boolean {
  return endingStage(state, content) === 'complete';
}
