import { type Clock, createManualClock, createSystemClock } from './clock.js';
import { type Lifecycle, createManualLifecycle, createWebLifecycle } from './lifecycle.js';
import { type Storage, createMemoryStorage, createWebStorage } from './storage.js';

export * from './clock.js';
export * from './storage.js';
export * from './lifecycle.js';

/**
 * Facade (spec §15): storage, clock and lifecycle behind one object, so the
 * app is written once and the web / Tauri / test hosts differ only here.
 */
export interface Platform {
  readonly id: string;
  readonly clock: Clock;
  readonly storage: Storage;
  readonly lifecycle: Lifecycle;
}

export function createMemoryPlatform(startMs = 0): Platform {
  return {
    id: 'memory',
    clock: createManualClock(startMs),
    storage: createMemoryStorage(),
    lifecycle: createManualLifecycle(),
  };
}

export interface WebPlatformOptions {
  readonly clock?: Clock;
  readonly storage?: Storage;
  readonly document?: Parameters<typeof createWebLifecycle>[0];
}

/**
 * The browser host: IndexedDB for saves, the system clock, and page visibility
 * for the offline-progress trigger. Everything is overridable so a dev build or
 * an E2E run can freeze time without the app knowing (spec §13, E2E row).
 */
export function createWebPlatform(options: WebPlatformOptions = {}): Platform {
  const doc =
    options.document ??
    (typeof document === 'undefined'
      ? undefined
      : (document as unknown as Parameters<typeof createWebLifecycle>[0]));
  return {
    id: 'web',
    clock: options.clock ?? createSystemClock(),
    storage: options.storage ?? createWebStorage(),
    lifecycle: createWebLifecycle(doc),
  };
}
