/**
 * Save schema version (Memento + migrations, spec §15/§19).
 * Bump on every persistent state shape change, add a migration in
 * `migrations.ts` and a fixture in `__fixtures__/` in the same commit.
 *
 * - v1 (M0): clock, tick count, phase id, rng position.
 * - v2 (M1): resources, filament, printers, slots, intro assembly, run stats.
 * - v3 (M3): scrap value, upgrades, automation, market, per-slot pity charge
 *   and changeover, failure/trade statistics.
 * - v4 (M4): per-slot print queues, and the run's Farm/Goliath commitment.
 * - v5 (M5): the Design Studio (owned designs, the bench, per-slot design),
 *   Products as a valued pool, the money printers, the prestige counter and
 *   the self-assembling intro flag.
 * - v6 (M6): the Endgame — the printed factory's accumulator, the Universal
 *   Fabricator (its pre-printed sections, the build in flight and the moment it
 *   finished), the New Game Plus run counter with its chosen modifiers, and
 *   the count of Plates ever engraved (which is what the presses read).
 * - v7 (M7 balance overhaul): every bay's perfect meter and overclock clocks.
 * - v8 (commissions): the commission board and the count of orders delivered.
 */
export const SAVE_SCHEMA_VERSION = 9;

/** Every version this build can still load — the fixture corpus mirrors it. */
export const SUPPORTED_SAVE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
