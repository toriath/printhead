import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createInitialState } from '../state/game-state.js';
import fixtureV1 from './__fixtures__/save-v1.json' with { type: 'json' };
import fixtureV2 from './__fixtures__/save-v2.json' with { type: 'json' };
import fixtureV3 from './__fixtures__/save-v3.json' with { type: 'json' };
import fixtureV4 from './__fixtures__/save-v4.json' with { type: 'json' };
import fixtureV5 from './__fixtures__/save-v5.json' with { type: 'json' };
import fixtureV6 from './__fixtures__/save-v6.json' with { type: 'json' };
import fixtureV7 from './__fixtures__/save-v7.json' with { type: 'json' };
import fixtureV8 from './__fixtures__/save-v8.json' with { type: 'json' };
import fixtureV9 from './__fixtures__/save-v9.json' with { type: 'json' };
import { MIGRATIONS, SaveMigrationError, migrateToCurrent } from './migrations.js';
import { GameStateSchema } from './schema.js';
import {
  SaveLoadError,
  deserializeSave,
  fromSaveFile,
  parseSave,
  serializeSave,
} from './serialize.js';
import { SAVE_SCHEMA_VERSION, SUPPORTED_SAVE_VERSIONS } from './version.js';

const content = loadContent(RAW_CONTENT);
const state = createInitialState(content, { seed: 20260812 });

describe('save round-trip', () => {
  it('serializes and restores an identical state', () => {
    expect(deserializeSave(serializeSave(state, 1000))).toEqual(state);
  });

  it('stamps the current schema version and the injected clock', () => {
    const parsed = JSON.parse(serializeSave(state, 4242)) as { version: number; savedAtMs: number };
    expect(parsed.version).toBe(SAVE_SCHEMA_VERSION);
    expect(parsed.savedAtMs).toBe(4242);
  });

  it('hands back the wall-clock stamp, which is what offline catch-up needs', () => {
    const loaded = parseSave(serializeSave(state, 4242));
    expect(loaded).toEqual({
      state,
      savedAtMs: 4242,
      fromVersion: SAVE_SCHEMA_VERSION,
    });
  });

  it('reports the version a migrated save came from', () => {
    expect(parseSave(JSON.stringify(fixtureV1)).fromVersion).toBe(1);
  });
});

/**
 * Every released schema version must load forever (spec §13). These fixtures
 * are frozen: never edit one to make a test pass — add a migration instead.
 */
describe('save fixture corpus', () => {
  it('covers every supported version', () => {
    expect([...SUPPORTED_SAVE_VERSIONS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(fixtureV1.version).toBe(1);
    expect(fixtureV2.version).toBe(2);
    expect(fixtureV3.version).toBe(3);
    expect(fixtureV4.version).toBe(4);
    expect(fixtureV5.version).toBe(5);
    expect(fixtureV6.version).toBe(6);
    expect(fixtureV7.version).toBe(7);
    expect(fixtureV8.version).toBe(8);
    expect(fixtureV9.version).toBe(9);
  });

  it('loads the released v1 fixture by migrating it forward', () => {
    const loaded = fromSaveFile(fixtureV1);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    // v1 predates the economy: its clock and phase survive, the rest starts empty.
    expect(loaded.simTimeMs).toBe(12300);
    expect(loaded.tickCount).toBe(123);
    expect(loaded.phaseId).toBe('bench');
    expect(loaded.rng).toEqual({ seed: 20260812, count: 7 });
    expect(loaded.resources.parts).toBe(0);
    expect(loaded.printers).toEqual({});
    expect(loaded.assembly.attachedPieceIds).toEqual([]);
    expect(loaded.slots).toHaveLength(1);
  });

  it('loads the released v2 fixture by migrating it forward', () => {
    const loaded = fromSaveFile(fixtureV2);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    // Everything v2 knew about survives verbatim...
    expect(loaded.printers['bench-mk1']).toBe(1);
    expect(loaded.stats.printsCompleted).toBeGreaterThan(0);
    expect(loaded.simTimeMs).toBe(fixtureV2.state.simTimeMs);
    // ...and everything M3 added starts empty, because that save never had it.
    expect(loaded.scrapValue).toBe(0);
    expect(loaded.upgrades).toEqual({});
    expect(loaded.automation).toEqual({});
    expect(loaded.market).toEqual({});
    expect(loaded.slots[0]?.failureCharge).toBe(0);
    expect(loaded.slots[0]?.changeoverMs).toBe(0);
    expect(loaded.stats.printsFailed).toBe(0);
  });

  it('loads the released v3 fixture by migrating it forward', () => {
    const loaded = fromSaveFile(fixtureV3);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    // Everything v3 knew about survives verbatim...
    expect(loaded.stats.printsCompleted).toBe(fixtureV3.state.stats.printsCompleted);
    expect(loaded.upgrades).toEqual(fixtureV3.state.upgrades);
    expect(loaded.slots).toHaveLength(fixtureV3.state.slots.length);
    // ...and everything M4 added starts empty: that save had no rota, and the
    // run it describes never made the Farm/Goliath commitment.
    expect(loaded.forkId).toBeNull();
    expect(loaded.slots[0]?.queue).toEqual([]);
    expect(loaded.slots[0]?.queueIndex).toBe(0);
    expect(loaded.slots[0]?.queueBatches).toBe(0);
  });

  it('loads the released v4 fixture by migrating it forward', () => {
    const loaded = fromSaveFile(fixtureV4);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    // The M4 shape the fixture exists to pin survives verbatim: a rack, a fleet
    // spread across it, a print rota and a committed fork.
    expect(loaded.slots.length).toBeGreaterThan(1);
    expect(loaded.forkId).toBe(fixtureV4.state.forkId);
    expect(loaded.slots.some((slot) => slot.queue.length > 0)).toBe(true);
    // ...and everything M5 added starts empty: that workshop never drafted a
    // Design, never melted itself down, and would still be clicked out by hand.
    expect(loaded.designs).toEqual({});
    expect(loaded.studio).toBeNull();
    expect(loaded.moneyPrinters).toEqual({});
    expect(loaded.selfAssembling).toBe(false);
    expect(loaded.productsValue).toBe(0);
    expect(loaded.slots.every((slot) => slot.designId === null)).toBe(true);
    expect(loaded.stats.prestigeCount).toBe(0);
    expect(loaded.stats.moneyPrinted).toBe(0);
  });

  it('loads the released v5 fixture by migrating it forward', () => {
    const loaded = fromSaveFile(fixtureV5);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    // The M5 shape the fixture exists to pin: Designs owned and levelled, a bay
    // making Products, a commission on the bench, Plates banked, a press
    // installed, and an intro that now rebuilds itself (spec §5D, §5E).
    expect(Object.keys(loaded.designs).length).toBeGreaterThan(0);
    expect(loaded.slots.some((slot) => slot.designId !== null)).toBe(true);
    expect(loaded.studio).not.toBeNull();
    expect(loaded.resources.plates).toBeGreaterThan(0);
    expect(loaded.productsValue).toBeGreaterThan(0);
    expect(Object.keys(loaded.moneyPrinters).length).toBeGreaterThan(0);
    expect(loaded.selfAssembling).toBe(true);
    expect(loaded.stats.prestigeCount).toBeGreaterThan(0);
    // ...and everything M6 added starts empty: that workshop had no factory,
    // had printed no section of the Fabricator and had never seen the credits.
    expect(loaded.factoryProgress).toBe(0);
    expect(loaded.fabricator).toEqual({
      sections: 0,
      sectionRun: null,
      run: null,
      completedAtMs: null,
    });
    expect(loaded.ngPlus).toEqual({ run: 0, modifierIds: [] });
  });

  it('loads the released v6 fixture, giving every bay a cold perfect meter and overclock', () => {
    const loaded = fromSaveFile(fixtureV6);
    expect(loaded.saveVersion).toBe(SAVE_SCHEMA_VERSION);
    for (const slot of loaded.slots) {
      expect(slot.perfectCharge).toBe(0);
      expect(slot.overclockMs).toBe(0);
      expect(slot.overclockCooldownMs).toBe(0);
    }
    const { commissions: _board, shop: _shop, ...rest } = loaded;
    expect({
      ...rest,
      saveVersion: 6,
      slots: fixtureV6.state.slots,
      stats: {
        ...rest.stats,
        commissionsCompleted: undefined,
        customersServed: undefined,
        customersMissed: undefined,
      },
    }).toEqual({
      ...fixtureV6.state,
      stats: { ...fixtureV6.state.stats, commissionsCompleted: undefined },
    });
    // The M6 shape the fixture exists to pin: an Endgame Tree bought with
    // Plates, a printed factory turning over, sections pre-printed for the
    // Fabricator and the final print itself in flight (spec §5E, §7.3).
    expect(loaded.upgrades['exotic-feedstock']).toBeGreaterThan(0);
    expect(loaded.upgrades['universal-fabricator']).toBeGreaterThan(0);
    expect(loaded.fabricator.sections).toBeGreaterThan(0);
    expect(loaded.fabricator.run).not.toBeNull();
    expect(loaded.phaseId).toBe('end');
  });

  it('migrates the released v7 fixture to an empty commission board', () => {
    const loaded = fromSaveFile(fixtureV7);
    expect(loaded.slots).toEqual(fixtureV7.state.slots);
    expect(loaded.commissions.open).toEqual([]);
    expect(loaded.stats.commissionsCompleted).toBe(0);
  });

  it('migrates the released v8 fixture to a shut shop and a board of taken-on orders', () => {
    const loaded = fromSaveFile(fixtureV8);
    expect(loaded.slots).toEqual(fixtureV8.state.slots);
    expect(loaded.shop.priceLevelId).toBe('closed');
    expect(loaded.commissions.loyalty).toEqual({});
    expect(loaded.commissions.open.every((offer) => offer.accepted)).toBe(true);
    expect(loaded.stats.customersServed).toBe(0);
  });

  it('loads the released v9 fixture untouched', () => {
    expect(fromSaveFile(fixtureV9)).toEqual(fixtureV9.state);
  });

  it('re-saving a migrated old save produces a current-schema file', () => {
    const round = deserializeSave(serializeSave(fromSaveFile(fixtureV1), 0));
    expect(GameStateSchema.safeParse(round).success).toBe(true);
  });
});

describe('save validation', () => {
  it('rejects malformed envelopes', () => {
    expect(() => fromSaveFile({ nope: true })).toThrow(SaveLoadError);
    expect(() => deserializeSave('{not json')).toThrow(SaveLoadError);
  });

  it('rejects payloads that do not match the state schema', () => {
    expect(() => fromSaveFile({ version: 1, savedAtMs: 0, state: { saveVersion: 1 } })).toThrow(
      SaveLoadError,
    );
  });

  it('rejects impossible ledgers', () => {
    const broken = {
      ...fixtureV2,
      state: { ...fixtureV2.state, resources: { ...fixtureV2.state.resources, parts: -1 } },
    };
    expect(() => fromSaveFile(broken)).toThrow(SaveLoadError);
  });

  it('refuses saves from a newer build', () => {
    expect(() =>
      fromSaveFile({ version: SAVE_SCHEMA_VERSION + 1, savedAtMs: 0, state: {} }),
    ).toThrow(SaveMigrationError);
  });

  it('refuses nonsensical versions', () => {
    expect(() => migrateToCurrent({}, 0)).toThrow(SaveMigrationError);
    expect(() => migrateToCurrent({}, 1.5)).toThrow(SaveMigrationError);
  });
});

describe('migrations', () => {
  it('has no gaps below the current version', () => {
    for (let version = 1; version < SAVE_SCHEMA_VERSION; version += 1) {
      expect(MIGRATIONS[version]).toBeTypeOf('function');
    }
  });

  it('passes the payload through unchanged at the current version', () => {
    const payload = { saveVersion: SAVE_SCHEMA_VERSION };
    expect(migrateToCurrent(payload, SAVE_SCHEMA_VERSION)).toBe(payload);
  });

  it('produces a payload the current schema accepts', () => {
    const migrated = migrateToCurrent(fixtureV1.state, 1);
    expect(GameStateSchema.safeParse(migrated).success).toBe(true);
  });
});
