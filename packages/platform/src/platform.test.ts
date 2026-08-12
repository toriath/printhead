// Installs IDBFactory/IDBRequest/… as globals, which is how `idb` finds them.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbStorage,
  createManualClock,
  createManualLifecycle,
  createMemoryPlatform,
  createMemoryStorage,
  createSystemClock,
  createWebLifecycle,
  createWebPlatform,
  createWebStorage,
} from './index.js';
import { INDEXED_DB_STORE, indexedDbAvailable } from './storage.js';

/** Write a value straight past the facade, to prove `read` guards its output. */
async function putRaw(dbName: string, key: string, value: unknown): Promise<void> {
  const open = globalThis.indexedDB.open(dbName, 1);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const tx = db.transaction(INDEXED_DB_STORE, 'readwrite');
  tx.objectStore(INDEXED_DB_STORE).put(value, key);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe('clock facade', () => {
  it('advances a manual clock deterministically', () => {
    const clock = createManualClock(1000);
    expect(clock.nowMs()).toBe(1000);
    clock.advance(500);
    expect(clock.nowMs()).toBe(1500);
  });

  it('jumps to an absolute time, which is how E2E fakes an offline gap', () => {
    const clock = createManualClock(1000);
    clock.set(9000);
    expect(clock.nowMs()).toBe(9000);
  });

  it('never moves backwards', () => {
    expect(() => createManualClock().advance(-1)).toThrow(RangeError);
    expect(() => createManualClock(500).set(100)).toThrow(RangeError);
    expect(() => createManualClock().advance(Number.NaN)).toThrow(RangeError);
  });

  it('exposes the system clock behind the same interface', () => {
    expect(typeof createSystemClock().nowMs()).toBe('number');
  });
});

describe('memory storage', () => {
  it('round-trips values and lists keys', async () => {
    const storage = createMemoryStorage();
    expect(await storage.read('save')).toBeNull();
    await storage.write('save', '{"version":1}');
    expect(await storage.read('save')).toBe('{"version":1}');
    expect(await storage.keys()).toEqual(['save']);
    await storage.remove('save');
    expect(await storage.keys()).toEqual([]);
  });

  it('seeds from an initial record', async () => {
    const storage = createMemoryStorage({ a: '1' });
    expect(await storage.read('a')).toBe('1');
  });
});

describe('IndexedDB storage', () => {
  let sequence = 0;
  let dbName = 'printhead-test';

  beforeEach(() => {
    // A fresh factory *and* a fresh database name per test: fake-indexeddb
    // keeps databases alive for the whole module otherwise.
    sequence += 1;
    dbName = `printhead-test-${sequence}`;
    globalThis.indexedDB = new IDBFactory();
  });

  it('persists across storage handles opened on the same database', async () => {
    const first = createIndexedDbStorage({ dbName });
    await first.write('save', 'hello');
    const second = createIndexedDbStorage({ dbName });
    expect(await second.read('save')).toBe('hello');
  });

  it('round-trips, lists and removes', async () => {
    const storage = createIndexedDbStorage({ dbName });
    expect(await storage.read('missing')).toBeNull();
    await storage.write('a', '1');
    await storage.write('b', '2');
    expect([...(await storage.keys())].sort()).toEqual(['a', 'b']);
    await storage.remove('a');
    expect(await storage.keys()).toEqual(['b']);
  });

  it('reuses one connection rather than opening per call', async () => {
    const open = vi.spyOn(globalThis.indexedDB, 'open');
    const storage = createIndexedDbStorage({ dbName });
    await storage.write('a', '1');
    await storage.write('b', '2');
    await storage.read('a');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('treats a non-string record as absent instead of crashing the boot', async () => {
    const storage = createIndexedDbStorage({ dbName });
    await storage.write('save', 'ok');
    await putRaw(dbName, 'save', 42);
    expect(await storage.read('save')).toBeNull();
  });

  it('falls back to memory when the host has no IndexedDB', async () => {
    const global = globalThis as { indexedDB: IDBFactory | undefined };
    const saved = global.indexedDB;
    global.indexedDB = undefined;
    try {
      expect(indexedDbAvailable()).toBe(false);
      const storage = createWebStorage({ dbName });
      await storage.write('save', 'x');
      expect(await storage.read('save')).toBe('x');
    } finally {
      global.indexedDB = saved;
    }
  });

  it('uses IndexedDB when one is available', async () => {
    expect(indexedDbAvailable()).toBe(true);
    const storage = createWebStorage({ dbName });
    await storage.write('save', 'x');
    expect(await createIndexedDbStorage({ dbName }).read('save')).toBe('x');
  });
});

describe('lifecycle facade', () => {
  it('notifies foreground and background transitions once each', () => {
    const lifecycle = createManualLifecycle(true);
    const fore = vi.fn();
    const back = vi.fn();
    lifecycle.onForeground(fore);
    lifecycle.onBackground(back);

    lifecycle.setVisible(false);
    lifecycle.setVisible(false);
    expect(back).toHaveBeenCalledTimes(1);
    expect(lifecycle.isVisible()).toBe(false);

    lifecycle.setVisible(true);
    expect(fore).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes', () => {
    const lifecycle = createManualLifecycle(true);
    const back = vi.fn();
    lifecycle.onBackground(back)();
    lifecycle.setVisible(false);
    expect(back).not.toHaveBeenCalled();
  });

  it('reads real document visibility events', () => {
    const lifecycle = createWebLifecycle(
      document as unknown as Parameters<typeof createWebLifecycle>[0],
    );
    const fore = vi.fn();
    const back = vi.fn();
    const stopFore = lifecycle.onForeground(fore);
    const stopBack = lifecycle.onBackground(back);

    const setVisibility = (value: string): void => {
      Object.defineProperty(document, 'visibilityState', { value, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    setVisibility('hidden');
    expect(back).toHaveBeenCalledTimes(1);
    expect(fore).not.toHaveBeenCalled();
    expect(lifecycle.isVisible()).toBe(false);

    setVisibility('visible');
    expect(fore).toHaveBeenCalledTimes(1);

    stopFore();
    stopBack();
    setVisibility('hidden');
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('treats pagehide as going to the background — the discarded-tab case', () => {
    const lifecycle = createWebLifecycle(
      document as unknown as Parameters<typeof createWebLifecycle>[0],
    );
    const back = vi.fn();
    const stop = lifecycle.onBackground(back);
    document.dispatchEvent(new Event('pagehide'));
    expect(back).toHaveBeenCalledTimes(1);
    stop();
    document.dispatchEvent(new Event('pagehide'));
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('degrades to always-visible when there is no document at all', () => {
    const lifecycle = createWebLifecycle(undefined);
    expect(lifecycle.isVisible()).toBe(true);
  });
});

describe('platform facades', () => {
  it('bundles a manual clock, memory storage and a manual lifecycle', () => {
    const platform = createMemoryPlatform(42);
    expect(platform.id).toBe('memory');
    expect(platform.clock.nowMs()).toBe(42);
    expect(platform.lifecycle.isVisible()).toBe(true);
  });

  it('assembles the web host and lets every part be overridden', async () => {
    const clock = createManualClock(7);
    const storage = createMemoryStorage();
    const platform = createWebPlatform({ clock, storage });
    expect(platform.id).toBe('web');
    expect(platform.clock.nowMs()).toBe(7);
    await platform.storage.write('k', 'v');
    expect(await storage.read('k')).toBe('v');
    expect(platform.lifecycle.id).toBe('web');
  });
});
