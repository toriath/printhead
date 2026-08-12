import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createInitialState } from '../state/game-state.js';
import fixtureV1 from './__fixtures__/save-v1.json' with { type: 'json' };
import fixtureV2 from './__fixtures__/save-v2.json' with { type: 'json' };
import fixtureV3 from './__fixtures__/save-v3.json' with { type: 'json' };
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
    expect([...SUPPORTED_SAVE_VERSIONS]).toEqual([1, 2, 3]);
    expect(fixtureV1.version).toBe(1);
    expect(fixtureV2.version).toBe(2);
    expect(fixtureV3.version).toBe(3);
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

  it('loads the released v3 fixture untouched', () => {
    const loaded = fromSaveFile(fixtureV3);
    expect(loaded).toEqual(fixtureV3.state);
    expect(loaded.stats.printsCompleted).toBeGreaterThan(0);
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
