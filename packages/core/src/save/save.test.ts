import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createInitialState } from '../state/game-state.js';
import fixtureV1 from './__fixtures__/save-v1.json' with { type: 'json' };
import { MIGRATIONS, SaveMigrationError, migrateToCurrent } from './migrations.js';
import { SaveLoadError, deserializeSave, fromSaveFile, serializeSave } from './serialize.js';
import { SAVE_SCHEMA_VERSION } from './version.js';

const state = createInitialState(loadContent(RAW_CONTENT), { seed: 20260812 });

describe('save round-trip', () => {
  it('serializes and restores an identical state', () => {
    expect(deserializeSave(serializeSave(state, 1000))).toEqual(state);
  });

  it('stamps the current schema version and the injected clock', () => {
    const parsed = JSON.parse(serializeSave(state, 4242)) as { version: number; savedAtMs: number };
    expect(parsed.version).toBe(SAVE_SCHEMA_VERSION);
    expect(parsed.savedAtMs).toBe(4242);
  });
});

describe('save fixture corpus', () => {
  it('loads the released v1 fixture (must hold forever)', () => {
    const loaded = fromSaveFile(fixtureV1);
    expect(loaded).toEqual({
      saveVersion: 1,
      simTimeMs: 12300,
      tickCount: 123,
      phaseId: 'bench',
      rng: { seed: 20260812, count: 7 },
    });
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
});
