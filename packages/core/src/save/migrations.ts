import { SAVE_SCHEMA_VERSION } from './version.js';

export type SaveMigration = (payload: unknown) => unknown;

/**
 * Keyed by the version being migrated *from*: `MIGRATIONS[n]` upgrades an
 * `n` payload to `n + 1`. v1 is the first released schema, so the table is
 * empty — the machinery exists so the first bump is a data change, not a
 * refactor. Released versions must load forever (spec §13, "Saves").
 */
export const MIGRATIONS: Readonly<Record<number, SaveMigration>> = {};

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
