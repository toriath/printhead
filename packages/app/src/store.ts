import {
  type Action,
  type ContentSource,
  type GameState,
  type ReduceContext,
  type VisualState,
  advance,
  createInitialState,
  createPaceMapping,
  createRng,
  createStaticContentSource,
  reduce,
  restoreRng,
  toVisualState,
} from '@printhead/core';
import { type Clock, createSystemClock } from '@printhead/platform';

/**
 * Store bridge (spec §10/§15): "the sim is the store". React subscribes here;
 * everything else — pace, ticking, projection — is core's job. The bridge owns
 * no gameplay logic, only wiring.
 */
export interface GameStore {
  getState(): GameState;
  getVisualState(): VisualState;
  dispatch(action: Action): void;
  /** Feed wall-clock milliseconds in; the engine turns them into fixed ticks. */
  advanceWallClock(wallDtMs: number): number;
  subscribe(listener: () => void): () => void;
}

export interface GameStoreOptions {
  readonly contentSource?: ContentSource;
  readonly clock?: Clock;
  readonly seed?: number;
}

const DEFAULT_SEED = 20260812;

export function createGameStore(options: GameStoreOptions = {}): GameStore {
  const contentSource = options.contentSource ?? createStaticContentSource();
  const clock: Clock = options.clock ?? createSystemClock();
  let content = contentSource.get();
  let pace = createPaceMapping(content.pacing);
  let state = createInitialState(content, { seed: options.seed ?? DEFAULT_SEED });
  // Cached so `useSyncExternalStore` sees a stable snapshot per state.
  let visual = toVisualState(state);
  let carrySimMs = 0;
  const listeners = new Set<() => void>();

  contentSource.subscribe((next) => {
    content = next;
    pace = createPaceMapping(next.pacing);
    notify();
  });

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function context(): ReduceContext {
    return { content, nowMs: clock.nowMs(), rng: restoreRng(state.rng) };
  }

  function setState(next: GameState): void {
    if (next === state) {
      return;
    }
    state = next;
    visual = toVisualState(next);
  }

  return {
    getState: () => state,
    getVisualState: () => visual,
    dispatch(action) {
      setState(reduce(state, action, context()));
      notify();
    },
    advanceWallClock(wallDtMs) {
      const ctx = context();
      const result = advance({
        state,
        carrySimMs,
        wallDtMs,
        pace,
        tick: (current, simDtMs) => reduce(current, { type: 'TICK', simDtMs }, ctx),
      });
      setState(result.state);
      carrySimMs = result.carrySimMs;
      if (result.ticks > 0) {
        notify();
      }
      return result.ticks;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Exposed for tests/dev tools that want a throwaway deterministic stream. */
export const createSeededRng = createRng;
