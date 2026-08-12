/**
 * Facade (spec §15): the app talks to storage and the clock only through these
 * interfaces, so web (IndexedDB/localStorage) and Tauri (fs) implementations
 * are swappable and the simulation stays free of both.
 *
 * M0 ships the seam plus an in-memory implementation used by tests and the
 * balance harness; real adapters land with saves in M1/M7.
 */
export interface Clock {
  /** Wall-clock milliseconds. The only place `Date.now` may be called. */
  nowMs(): number;
}

export interface Storage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface Platform {
  readonly id: string;
  readonly clock: Clock;
  readonly storage: Storage;
}

export function createSystemClock(): Clock {
  return { nowMs: () => Date.now() };
}

/** Deterministic clock for tests, replays and the headless harness. */
export function createManualClock(startMs = 0): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    nowMs: () => current,
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`clock cannot move backwards, received ${ms}`);
      }
      current += ms;
    },
  };
}

export function createMemoryStorage(initial: Readonly<Record<string, string>> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    read: (key) => Promise.resolve(map.get(key) ?? null),
    write: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
  };
}

export function createMemoryPlatform(startMs = 0): Platform {
  return {
    id: 'memory',
    clock: createManualClock(startMs),
    storage: createMemoryStorage(),
  };
}
