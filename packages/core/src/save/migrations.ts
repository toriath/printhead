import { SAVE_SCHEMA_VERSION } from './version.js';

export type SaveMigration = (payload: unknown) => unknown;

/**
 * v1 (M0) predates the economy entirely: it stored only the clock, the phase
 * and the rng position. A v1 save therefore restores into a fresh workshop —
 * the intro assembly is unbuilt and the ledger is empty — which is exactly what
 * that save described. Ids here are historical constants, not balance values.
 */
const V1_SLOT_ID = 'slot-1';

function migrateV1ToV2(payload: unknown): unknown {
  const v1 = payload as Record<string, unknown>;
  return {
    saveVersion: 2,
    simTimeMs: v1.simTimeMs,
    tickCount: v1.tickCount,
    phaseId: v1.phaseId,
    phaseEnteredAtMs: 0,
    rng: v1.rng,
    resources: { parts: 0, scrap: 0, money: 0, designs: 0, products: 0, plates: 0 },
    partsValue: 0,
    filamentGrams: {},
    printers: {},
    slots: [
      {
        id: V1_SLOT_ID,
        materialId: null,
        objectId: null,
        printerCount: 0,
        autoRestart: false,
        run: null,
      },
    ],
    assembly: { attachedPieceIds: [], cooldownMs: 0 },
    stats: {
      printsCompleted: 0,
      partsProduced: 0,
      partsSold: 0,
      moneyEarned: 0,
      filamentPurchasedGrams: 0,
    },
  };
}

/**
 * v2 (M1) predates failure, the market, upgrades and automation. A v2 save is
 * therefore a workshop that has bought nothing and wasted nothing: every new
 * ledger starts empty and every new counter at zero.
 *
 * The market ledger is left empty rather than seeded with opening stock. It is
 * keyed by material id and `marketStateOf` already treats a missing entry as
 * "no stock yet", which the first `tickMarket` restocks from the listing — so
 * the migration does not have to know today's content to produce a save that
 * behaves correctly under tomorrow's.
 */
function migrateV2ToV3(payload: unknown): unknown {
  const v2 = payload as Record<string, unknown>;
  const slots = Array.isArray(v2.slots) ? v2.slots : [];
  const stats = (v2.stats ?? {}) as Record<string, unknown>;
  return {
    ...v2,
    saveVersion: 3,
    scrapValue: 0,
    upgrades: {},
    automation: {},
    market: {},
    slots: slots.map((slot) => ({
      ...(slot as Record<string, unknown>),
      failureCharge: 0,
      changeoverMs: 0,
    })),
    stats: {
      ...stats,
      printsFailed: 0,
      filamentSoldGrams: 0,
      scrapProducedGrams: 0,
      scrapRecycledGrams: 0,
    },
  };
}

/**
 * v3 (M3) predates the slot rack, the fleet allocator and the Farm/Goliath
 * fork. A v3 save is a one-bay workshop that has made no commitment: every slot
 * gets an empty rota and the run's fork is still open. The bays it *owns* are
 * whatever it already had — slot progression is read off `slots.length`, so a
 * save from before the mechanic existed describes itself correctly.
 */
function migrateV3ToV4(payload: unknown): unknown {
  const v3 = payload as Record<string, unknown>;
  const slots = Array.isArray(v3.slots) ? v3.slots : [];
  return {
    ...v3,
    saveVersion: 4,
    forkId: null,
    slots: slots.map((slot) => ({
      ...(slot as Record<string, unknown>),
      queue: [],
      queueIndex: 0,
      queueBatches: 0,
    })),
  };
}

/**
 * v4 (M4) predates the Design Studio, Products, prestige and the money
 * printers. A v4 save is therefore a workshop that has never drafted anything
 * and never melted itself down: the design ledger is empty, the bench is free,
 * no bay is printing a Design, and the intro would still have to be clicked
 * out by hand — which is exactly what that save described.
 */
function migrateV4ToV5(payload: unknown): unknown {
  const v4 = payload as Record<string, unknown>;
  const slots = Array.isArray(v4.slots) ? v4.slots : [];
  const stats = (v4.stats ?? {}) as Record<string, unknown>;
  return {
    ...v4,
    saveVersion: 5,
    productsValue: 0,
    designs: {},
    studio: null,
    moneyPrinters: {},
    selfAssembling: false,
    slots: slots.map((slot) => ({ ...(slot as Record<string, unknown>), designId: null })),
    stats: {
      ...stats,
      productsProduced: 0,
      productsSold: 0,
      moneyPrinted: 0,
      prestigeCount: 0,
    },
  };
}

/**
 * v5 (M5) predates the Endgame entirely: no factory, no Fabricator, no New Game
 * Plus. A v5 save is therefore a workshop that has printed no sections and
 * finished nothing — which is exactly what it described. The ending is timed
 * from `fabricator.completedAtMs`, and `null` is the honest reading of "this
 * save has not seen the credits".
 */
function migrateV5ToV6(payload: unknown): unknown {
  const v5 = payload as Record<string, unknown>;
  const stats = (v5.stats ?? {}) as Record<string, unknown>;
  const resources = (v5.resources ?? {}) as Record<string, unknown>;
  return {
    ...v5,
    saveVersion: 6,
    factoryProgress: 0,
    fabricator: { sections: 0, sectionRun: null, run: null, completedAtMs: null },
    ngPlus: { run: 0, modifierIds: [] },
    stats: {
      ...stats,
      // v5 never recorded how many Plates had been engraved, only how many were
      // left. The Plates in hand are the honest lower bound, and reading them
      // keeps a v5 save's presses running at the rate it was used to.
      platesEarned: typeof resources.plates === 'number' ? resources.plates : 0,
    },
  };
}

/**
 * v6 → v7: the perfect meter and the overclock (balance overhaul). A v6 bay had
 * neither, so it starts with an empty meter and a cold, ready overclock.
 */
function migrateV6ToV7(payload: unknown): unknown {
  const v6 = payload as Record<string, unknown>;
  const slots = Array.isArray(v6.slots) ? (v6.slots as Record<string, unknown>[]) : [];
  return {
    ...v6,
    saveVersion: 7,
    slots: slots.map((slot) => ({
      ...slot,
      perfectCharge: 0,
      overclockMs: 0,
      overclockCooldownMs: 0,
    })),
  };
}

/**
 * v7 → v8: the commission board. A v7 save never saw one, so it starts empty,
 * with the first offer due shortly (the value `commissions.json` ships with is
 * not known here, so a minute is used) and nothing delivered.
 */
const V8_FIRST_OFFER_MS = 60_000;
function migrateV7ToV8(payload: unknown): unknown {
  const v7 = payload as Record<string, unknown>;
  const stats = (v7.stats ?? {}) as Record<string, unknown>;
  return {
    ...v7,
    saveVersion: 8,
    commissions: { open: [], nextOfferMs: V8_FIRST_OFFER_MS, issued: 0 },
    stats: { ...stats, commissionsCompleted: 0 },
  };
}

/**
 * Keyed by the version being migrated *from*: `MIGRATIONS[n]` upgrades an
 * `n` payload to `n + 1`. Released versions must load forever (spec §13).
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
  5: migrateV5ToV6,
  6: migrateV6ToV7,
  7: migrateV7ToV8,
};

export class SaveMigrationError extends Error {
  constructor(
    public readonly fromVersion: number,
    message: string,
  ) {
    super(message);
    this.name = 'SaveMigrationError';
  }
}

export function migrateToCurrent(payload: unknown, fromVersion: number): unknown {
  if (!Number.isInteger(fromVersion) || fromVersion <= 0) {
    throw new SaveMigrationError(fromVersion, `invalid save version: ${fromVersion}`);
  }
  if (fromVersion > SAVE_SCHEMA_VERSION) {
    throw new SaveMigrationError(
      fromVersion,
      `save was written by a newer build (v${fromVersion} > v${SAVE_SCHEMA_VERSION})`,
    );
  }
  let current = payload;
  for (let version = fromVersion; version < SAVE_SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) {
      throw new SaveMigrationError(version, `missing save migration from v${version}`);
    }
    current = migration(current);
  }
  return current;
}
