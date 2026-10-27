import type { GameState } from '@printhead/core';
import type { ManualClock } from '@printhead/platform';
import type { BootedGame } from '../boot.js';

/**
 * Dev/E2E test seam (spec §14, §13 E2E row).
 *
 * At `targetHours: 8` the intro takes five real minutes, which is not a thing a
 * browser test can wait for. So dev builds boot on a *manual* clock and expose
 * `warp()`: the game still runs through the real loop, the real reducer and the
 * real pace mapping — only the clock is under the test's control. Nothing here
 * shortcuts a rule; a warped intro still needs the same seven clicks.
 *
 * It is created only under `import.meta.env.DEV`, so Vite tree-shakes the whole
 * module out of a production build (§14: "excluded from production bundles").
 */
export const DEV_HOOKS_KEY = '__PRINTHEAD__';
export const BOOT_OVERRIDES_KEY = '__PRINTHEAD_BOOT__';

/** Set by `page.addInitScript` before the app's own scripts run. */
export interface BootOverrides {
  /** Freeze wall-clock time at this value and drive it with `warp()`. */
  readonly nowMs?: number;
  /** Boot without starting the frame loop. */
  readonly paused?: boolean;
}

const WARP_STEP_MS = 10_000;

export interface DevHooks {
  readonly game: BootedGame;
  /**
   * Play `wallMs` of wall-clock time instantly, as if the game had been open
   * and watched the whole while. (A real gap that long is time away, which is
   * not simulated.)
   */
  warp(wallMs: number): void;
  /** The platform clock as the game sees it. */
  nowMs(): number;
  /** JSON snapshot of the simulation state, for save/reload equality checks. */
  snapshot(): GameState;
  saveNow(): Promise<void>;
  pause(): void;
  resume(): void;
}

export function readBootOverrides(scope: Record<string, unknown>): BootOverrides {
  const raw = scope[BOOT_OVERRIDES_KEY];
  if (raw === null || typeof raw !== 'object') {
    return {};
  }
  const { nowMs, paused } = raw as BootOverrides;
  return {
    ...(typeof nowMs === 'number' ? { nowMs } : {}),
    ...(typeof paused === 'boolean' ? { paused } : {}),
  };
}

export interface InstallDevHooksOptions {
  readonly scope: Record<string, unknown>;
  readonly game: BootedGame;
  /** Present when the boot overrides froze time; absent on a normal dev run. */
  readonly clock?: ManualClock;
}

export function installDevHooks(options: InstallDevHooksOptions): DevHooks {
  const { game, clock } = options;
  const hooks: DevHooks = {
    game,
    warp(wallMs) {
      if (clock === undefined) {
        throw new Error('warp() needs a manual clock — boot with __PRINTHEAD_BOOT__.nowMs');
      }
      // Small steps, so no single advance hits the per-call tick cap.
      for (let left = wallMs; left > 0; left -= WARP_STEP_MS) {
        game.store.advanceWallClock(Math.min(WARP_STEP_MS, left));
      }
      clock.advance(wallMs);
      // The loop sees the jump as time away and drops it, so nothing is
      // counted twice.
      game.loop.frame();
    },
    nowMs: () => game.platform.clock.nowMs(),
    snapshot: () => game.store.getState(),
    saveNow: () => game.autosave.saveNow(),
    pause: () => game.loop.stop(),
    resume: () => game.loop.start(),
  };
  options.scope[DEV_HOOKS_KEY] = hooks;
  return hooks;
}
