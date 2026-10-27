import {
  type Action,
  type Content,
  type ContentSource,
  type DomainEvent,
  type EventBus,
  type GameState,
  type ReduceContext,
  type VisualState,
  advance,
  createEventBus,
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
 * everything else — pace, ticking, projection — is core's
 * job. The bridge owns no gameplay logic, only wiring.
 */
export interface GameStore {
  getState(): GameState;
  getVisualState(): VisualState;
  getContent(): Content;
  dispatch(action: Action): void;
  /** Replace the whole state — loading a save, or a dev-tool jump. */
  replaceState(state: GameState): void;
  /** Feed wall-clock milliseconds in; the engine turns them into fixed ticks. */
  advanceWallClock(wallDtMs: number): number;
  subscribe(listener: () => void): () => void;
  /** Domain events (Observer, spec §15) — for sound, flourishes, achievements. */
  onEvent(listener: (event: DomainEvent) => void): () => void;
  /**
   * Every dispatched `Action`, as it happens. Ticks do not appear: they arrive
   * through `advanceWallClock`, so this is exactly the player's clicks — which
   * is what the editor's action-log tail (spec §14) is for, and what a
   * `(seed, actionLog)` bug report (spec §13) would need.
   */
  onAction(listener: (action: Action) => void): () => void;
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
  const bus: EventBus = createEventBus({ buffer: false });
  let content = contentSource.get();
  let pace = createPaceMapping(content.pacing);
  let state = createInitialState(content, { seed: options.seed ?? DEFAULT_SEED });
  // Cached so `useSyncExternalStore` sees a stable snapshot per state.
  let visual = toVisualState(state, content);
  let carrySimMs = 0;
  const listeners = new Set<() => void>();
  const actionListeners = new Set<(action: Action) => void>();

  contentSource.subscribe((next) => {
    content = next;
    pace = createPaceMapping(next.pacing);
    visual = toVisualState(state, content);
    notify();
  });

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  function context(): ReduceContext {
    return { content, nowMs: clock.nowMs(), rng: restoreRng(state.rng), emit: bus.emit };
  }

  function setState(next: GameState): void {
    if (next === state) {
      return;
    }
    state = next;
    visual = toVisualState(next, content);
  }

  return {
    getState: () => state,
    getVisualState: () => visual,
    getContent: () => content,
    dispatch(action) {
      setState(reduce(state, action, context()));
      for (const listener of actionListeners) {
        listener(action);
      }
      notify();
    },
    replaceState(next) {
      // A loaded save carries its own accumulated fraction of a tick with it
      // only implicitly: whatever was mid-tick when the game closed is gone, so
      // the carry starts clean rather than applying the old session's remainder
      // to the new one.
      carrySimMs = 0;
      state = next;
      visual = toVisualState(next, content);
      notify();
    },
    advanceWallClock(wallDtMs) {
      const ctx = context();
      const result = advance({
        state,
        carrySimMs,
        wallDtMs,
        pace,
        tick: (current, simDtMs) =>
          reduce(current, { type: 'TICK', simDtMs }, { ...ctx, rng: restoreRng(current.rng) }),
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
    onEvent(listener) {
      return bus.subscribe(listener);
    },
    onAction(listener) {
      actionListeners.add(listener);
      return () => {
        actionListeners.delete(listener);
      };
    },
  };
}

/** Exposed for tests/dev tools that want a throwaway deterministic stream. */
export const createSeededRng = createRng;
