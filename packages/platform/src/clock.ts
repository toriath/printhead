/**
 * Clock facade (spec §15). `core` never calls `Date.now` (spec §13); the app
 * feeds it wall-clock time through this seam, which is also what lets tests,
 * the balance harness and Playwright drive the game on a clock they control.
 */
export interface Clock {
  /** Wall-clock milliseconds. The only place `Date.now` may be called. */
  nowMs(): number;
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

export function createSystemClock(): Clock {
  return { nowMs: () => Date.now() };
}

/** Deterministic clock for tests, replays, the headless harness and E2E. */
export function createManualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    nowMs: () => current,
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`clock cannot move backwards, received ${ms}`);
      }
      current += ms;
    },
    set(ms: number) {
      if (!Number.isFinite(ms) || ms < current) {
        throw new RangeError(`clock cannot move backwards, received ${ms}`);
      }
      current = ms;
    },
  };
}
