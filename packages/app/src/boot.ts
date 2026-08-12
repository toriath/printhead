import type { ContentSource, OfflineSummary } from '@printhead/core';
import type { Platform } from '@printhead/platform';
import { type Autosave, createAutosave } from './autosave.js';
import { type GameLoop, createGameLoop } from './loop.js';
import { type LoadOutcome, SAVE_KEY, type SaveIo, readSave } from './persistence.js';
import { type GameStore, createGameStore } from './store.js';

/**
 * Boot: load the save, work out how long the player was away, replay that time
 * through the same reducer, and hand the shell a running game.
 *
 * It is a plain async function with every dependency injected, so the whole
 * start-up path — including "you were away for two hours" — is unit-testable
 * without a browser (spec §13).
 */
export interface BootOptions {
  readonly platform: Platform;
  readonly contentSource?: ContentSource;
  readonly seed?: number;
  readonly saveKey?: string;
  /** Skip the loop; E2E and tests step frames by hand. */
  readonly autoStart?: boolean;
  readonly autosaveIntervalMs?: number;
  readonly offlineThresholdMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface BootedGame {
  readonly platform: Platform;
  readonly store: GameStore;
  readonly loop: GameLoop;
  readonly autosave: Autosave;
  readonly io: SaveIo;
  /** Why (or whether) a save was restored — the shell can say so. */
  readonly load: LoadOutcome;
  /** The catch-up applied for the time between the save and this boot. */
  readonly offline: OfflineSummary | null;
  subscribeOffline(listener: (summary: OfflineSummary) => void): () => void;
  shutdown(): Promise<void>;
}

export async function bootGame(options: BootOptions): Promise<BootedGame> {
  const { platform } = options;
  const io: SaveIo = { storage: platform.storage, key: options.saveKey ?? SAVE_KEY };
  const store = createGameStore({
    ...(options.contentSource === undefined ? {} : { contentSource: options.contentSource }),
    clock: platform.clock,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });

  const load = await readSave(io);
  let offline: OfflineSummary | null = null;
  if (load.kind === 'loaded') {
    store.replaceState(load.save.state);
    // Wall-clock, not sim time: `savedAtMs` is the only honest record of when
    // the player left. A clock that moved backwards (timezone fiddling, a
    // restored backup) yields zero rather than negative progress.
    const awayMs = Math.max(platform.clock.nowMs() - load.save.savedAtMs, 0);
    if (awayMs > 0) {
      offline = store.applyOffline(awayMs);
    }
  }

  const offlineListeners = new Set<(summary: OfflineSummary) => void>();
  const autosave = createAutosave({
    store,
    clock: platform.clock,
    io,
    ...(options.autosaveIntervalMs === undefined ? {} : { intervalMs: options.autosaveIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const loop = createGameLoop({
    store,
    clock: platform.clock,
    lifecycle: platform.lifecycle,
    ...(options.offlineThresholdMs === undefined
      ? {}
      : { offlineThresholdMs: options.offlineThresholdMs }),
    onOffline(summary) {
      for (const listener of offlineListeners) {
        listener(summary);
      }
    },
    onBackground() {
      void autosave.saveNow();
    },
  });

  store.subscribe(() => {
    void autosave.maybeSave();
  });

  if (options.autoStart !== false) {
    loop.start();
  }

  return {
    platform,
    store,
    loop,
    autosave,
    io,
    load,
    offline,
    subscribeOffline(listener) {
      offlineListeners.add(listener);
      return () => {
        offlineListeners.delete(listener);
      };
    },
    async shutdown() {
      loop.stop();
      await autosave.saveNow();
      autosave.stop();
    },
  };
}
