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
 * Keyed by the version being migrated *from*: `MIGRATIONS[n]` upgrades an
 * `n` payload to `n + 1`. Released versions must load forever (spec §13).
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
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
