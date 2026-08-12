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
 * Keyed by the version being migrated *from*: `MIGRATIONS[n]` upgrades an
 * `n` payload to `n + 1`. Released versions must load forever (spec §13).
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {
  1: migrateV1ToV2,
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
