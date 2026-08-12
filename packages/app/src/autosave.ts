import { MS_PER_SECOND } from '@printhead/core';
import type { Clock } from '@printhead/platform';
import { type SaveIo, writeSave } from './persistence.js';
import type { GameStore } from './store.js';

/**
 * Autosave. Rate-limited by the *platform clock*, not by tick count, because
 * the point is to bound how much real time a crash can cost — and at
 * `targetHours: 4` twice as many ticks happen per real second.
 */
export const AUTOSAVE_INTERVAL_MS = 10 * MS_PER_SECOND;

export interface AutosaveOptions {
  readonly store: GameStore;
  readonly clock: Clock;
  readonly io: SaveIo;
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface Autosave {
  /** Save right now, ignoring the interval (quitting, backgrounding, tests). */
  saveNow(): Promise<void>;
  /** Save only if the interval has elapsed. Safe to call every frame. */
  maybeSave(): Promise<void>;
  lastSavedAtMs(): number | null;
  stop(): void;
}

export function createAutosave(options: AutosaveOptions): Autosave {
  const interval = options.intervalMs ?? AUTOSAVE_INTERVAL_MS;
  let lastSavedAtMs: number | null = null;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  let stopped = false;

  /** Reads the state and the clock *at write time*, never at request time. */
  async function flush(): Promise<void> {
    const at = options.clock.nowMs();
    try {
      await writeSave(options.io, options.store.getState(), at);
      lastSavedAtMs = at;
    } catch (error) {
      options.onError?.(error);
    }
  }

  /**
   * Writes are serialised, and at most one is ever queued behind the one in
   * flight: a slow disk must not build up a save per frame. Coalescing is safe
   * *because* the queued write samples the state when it runs — an earlier
   * request never persists a snapshot older than the moment it completes.
   */
  function saveNow(): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (queued) {
      return chain;
    }
    queued = true;
    chain = chain.then(() => {
      queued = false;
      return flush();
    });
    return chain;
  }

  return {
    saveNow,
    maybeSave() {
      const now = options.clock.nowMs();
      if (lastSavedAtMs !== null && now - lastSavedAtMs < interval) {
        return Promise.resolve();
      }
      return saveNow();
    },
    lastSavedAtMs: () => lastSavedAtMs,
    stop() {
      stopped = true;
    },
  };
}
