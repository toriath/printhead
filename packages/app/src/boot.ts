import type { ContentSource } from '@printhead/core';
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
  readonly awayThresholdMs?: number;
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
  if (load.kind === 'loaded') {
    // The save resumes exactly where it was left: time away is not simulated
    // (spec §7.4), so how long ago it was written does not matter.
    store.replaceState(load.save.state);
  }

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
    ...(options.awayThresholdMs === undefined ? {} : { awayThresholdMs: options.awayThresholdMs }),
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
    async shutdown() {
      loop.stop();
      await autosave.saveNow();
      autosave.stop();
    },
  };
}
