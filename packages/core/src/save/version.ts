/**
 * Save schema version (Memento + migrations, spec §15/§19).
 * Bump on every persistent state shape change, add a migration in
 * `migrations.ts` and a fixture in `__fixtures__/` in the same commit.
 *
 * - v1 (M0): clock, tick count, phase id, rng position.
 * - v2 (M1): resources, filament, printers, slots, intro assembly, run stats.
 */
export const SAVE_SCHEMA_VERSION = 2;

/** Every version this build can still load — the fixture corpus mirrors it. */
export const SUPPORTED_SAVE_VERSIONS = [1, 2] as const;
