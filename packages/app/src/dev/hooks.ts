import type { GameState, OfflineSummary } from '@printhead/core';
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

export interface DevHooks {
  readonly game: BootedGame;
  /** Advance wall-clock time and run one frame — the whole loop, instantly. */
  warp(wallMs: number): void;
  /** JSON snapshot of the simulation state, for save/reload equality checks. */
  snapshot(): GameState;
  saveNow(): Promise<void>;
  /** Rewrite the stored save's timestamp to fake having been away. */
  lastOffline(): OfflineSummary | null;
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
  let lastOffline: OfflineSummary | null = game.offline;
  game.subscribeOffline((summary) => {
    lastOffline = summary;
  });

  const hooks: DevHooks = {
    game,
    warp(wallMs) {
      if (clock === undefined) {
        throw new Error('warp() needs a manual clock — boot with __PRINTHEAD_BOOT__.nowMs');
      }
      clock.advance(wallMs);
      game.loop.frame();
    },
    snapshot: () => game.store.getState(),
    saveNow: () => game.autosave.saveNow(),
    lastOffline: () => lastOffline,
    pause: () => game.loop.stop(),
    resume: () => game.loop.start(),
  };
  options.scope[DEV_HOOKS_KEY] = hooks;
  return hooks;
}
