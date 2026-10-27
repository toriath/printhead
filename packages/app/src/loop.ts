import { MS_PER_MINUTE } from '@printhead/core';
import type { Clock, Lifecycle } from '@printhead/platform';
import type { GameStore } from './store.js';

/**
 * The engine loop (spec §15: fixed timestep, render reads at rAF pace).
 *
 * The frame callback does *not* trust the frame timestamp — it asks the
 * platform clock how much wall-clock time really passed. That single choice
 * handles background throttling, a suspended iOS web view and a laptop lid on
 * the same code path: a gap longer than {@link AWAY_THRESHOLD_MS} is not a
 * slow frame, it is time away, and **time away is not simulated** (spec §7.4).
 * The workshop only runs while someone is watching it.
 */
export type FrameScheduler = (callback: () => void) => () => void;

/** Gaps beyond this are treated as "the player was away", not as a slow frame. */
export const AWAY_THRESHOLD_MS = MS_PER_MINUTE;

export interface GameLoopOptions {
  readonly store: GameStore;
  readonly clock: Clock;
  readonly lifecycle?: Lifecycle;
  /** Injected so tests and E2E can step frames by hand. */
  readonly schedule?: FrameScheduler;
  readonly awayThresholdMs?: number;
  /** Called when the game goes to the background — the moment to save. */
  readonly onBackground?: () => void;
}

export interface GameLoop {
  start(): void;
  stop(): void;
  /** Run one frame now. Returns the wall milliseconds it consumed. */
  frame(): number;
  isRunning(): boolean;
  /**
   * Dev time-warp (spec §14): multiplies the wall-clock gap handed to the
   * engine, **on top of** the pace mapping and never instead of it. The scale
   * factor of spec §8 still lives in exactly one place — `engine/pace.ts` — and
   * still does the same job; this only lies to the loop about how long a frame
   * took, which is the same lie a slow laptop tells it. Defaults to 1, so a
   * production build behaves as if it did not exist.
   */
  setTimeScale(scale: number): void;
  getTimeScale(): number;
}

const defaultScheduler: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 16);
    return () => clearTimeout(timer);
  }
  const handle = requestAnimationFrame(() => callback());
  return () => cancelAnimationFrame(handle);
};

export function createGameLoop(options: GameLoopOptions): GameLoop {
  const { store, clock } = options;
  const schedule = options.schedule ?? defaultScheduler;
  const threshold = options.awayThresholdMs ?? AWAY_THRESHOLD_MS;
  let cancel: (() => void) | null = null;
  // Primed at construction, not at `start()`: boot has just finished replaying
  // the time away, so "now" is the correct baseline whether or not the caller
  // starts the pump immediately (tests and E2E step `frame()` by hand).
  let lastMs: number | null = clock.nowMs();
  let stopBackground: (() => void) | null = null;
  let timeScale = 1;

  function frame(): number {
    const now = clock.nowMs();
    const previous = lastMs;
    lastMs = now;
    if (previous === null) {
      return 0;
    }
    const elapsed = Math.max(now - previous, 0) * timeScale;
    if (elapsed >= threshold) {
      // The player was away. Nothing happened while they were gone.
      return 0;
    }
    store.advanceWallClock(elapsed);
    return elapsed;
  }

  function pump(): void {
    frame();
    cancel = schedule(pump);
  }

  return {
    start() {
      if (cancel !== null) {
        return;
      }
      lastMs = clock.nowMs();
      cancel = schedule(pump);
      stopBackground = options.lifecycle?.onBackground(() => options.onBackground?.()) ?? null;
    },
    stop() {
      cancel?.();
      cancel = null;
      lastMs = null;
      stopBackground?.();
      stopBackground = null;
    },
    frame,
    isRunning: () => cancel !== null,
    setTimeScale(scale) {
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new RangeError(`time scale must be positive, received ${scale}`);
      }
      timeScale = scale;
    },
    getTimeScale: () => timeScale,
  };
}
