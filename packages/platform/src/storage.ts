import { type IDBPDatabase, openDB } from 'idb';

/**
 * Storage facade (spec §15): the app persists saves through this interface
 * only, so IndexedDB on the web, the Tauri filesystem on macOS/iOS and a plain
 * `Map` in tests are interchangeable and `core` knows about none of them.
 */
export interface Storage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
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

export const INDEXED_DB_NAME = 'printhead';
export const INDEXED_DB_STORE = 'kv';
const INDEXED_DB_VERSION = 1;

export interface IndexedDbStorageOptions {
  readonly dbName?: string;
  readonly storeName?: string;
}

/**
 * `idb` resolves the factory off `globalThis` rather than taking one, so
 * availability is a global question and this is the one place that asks it.
 * Tests install `fake-indexeddb/auto`; a private-mode browser answers false.
 */
export function indexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

/**
 * IndexedDB-backed storage. The database handle is opened lazily and reused:
 * a save every few seconds must not pay for a connection every time.
 */
export function createIndexedDbStorage(options: IndexedDbStorageOptions = {}): Storage {
  const dbName = options.dbName ?? INDEXED_DB_NAME;
  const storeName = options.storeName ?? INDEXED_DB_STORE;
  let handle: Promise<IDBPDatabase> | null = null;

  const db = (): Promise<IDBPDatabase> => {
    handle ??= openDB(dbName, INDEXED_DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName);
        }
      },
    });
    return handle;
  };

  return {
    async read(key) {
      const value: unknown = await (await db()).get(storeName, key);
      return typeof value === 'string' ? value : null;
    },
    async write(key, value) {
      await (await db()).put(storeName, value, key);
    },
    async remove(key) {
      await (await db()).delete(storeName, key);
    },
    async keys() {
      const keys = await (await db()).getAllKeys(storeName);
      return keys.map(String);
    },
  };
}

/**
 * Falls back rather than throwing: a browser in private mode, an iOS web view
 * with storage disabled or a Node test runner all still get a working game —
 * they just lose the save when the tab closes, which beats a blank screen.
 */
export function createWebStorage(options: IndexedDbStorageOptions = {}): Storage {
  return indexedDbAvailable() ? createIndexedDbStorage(options) : createMemoryStorage();
}
