import type { GameState } from '../state/game-state.js';
import { migrateToCurrent } from './migrations.js';
import { GameStateSchema, type SaveFile, SaveFileSchema } from './schema.js';
import { SAVE_SCHEMA_VERSION } from './version.js';

export class SaveLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveLoadError';
  }
}

export function toSaveFile(state: GameState, nowMs: number): SaveFile {
  return { version: SAVE_SCHEMA_VERSION, savedAtMs: nowMs, state };
}

export function serializeSave(state: GameState, nowMs: number): string {
  return JSON.stringify(toSaveFile(state, nowMs));
}

/**
 * A loaded save plus the envelope around it. `savedAtMs` is wall-clock time, so
 * it is the only honest input to "how long was the player away?" — the offline
 * catch-up on boot (spec §7.4) is computed from it, never from sim time.
 */
export interface LoadedSave {
  readonly state: GameState;
  readonly savedAtMs: number;
  /** The version the file was written at, before migrations ran. */
  readonly fromVersion: number;
}

export function parseSaveFile(raw: unknown): LoadedSave {
  const file = SaveFileSchema.safeParse(raw);
  if (!file.success) {
    throw new SaveLoadError(`malformed save file: ${file.error.issues[0]?.message ?? 'unknown'}`);
  }
  const migrated = migrateToCurrent(file.data.state, file.data.version);
  const state = GameStateSchema.safeParse(migrated);
  if (!state.success) {
    const issue = state.error.issues[0];
    throw new SaveLoadError(
      `save state failed validation: ${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return { state: state.data, savedAtMs: file.data.savedAtMs, fromVersion: file.data.version };
}

export function fromSaveFile(raw: unknown): GameState {
  return parseSaveFile(raw).state;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new SaveLoadError(`save file is not valid JSON: ${(error as Error).message}`);
  }
}

export function deserializeSave(json: string): GameState {
  return fromSaveFile(parseJson(json));
}

export function parseSave(json: string): LoadedSave {
  return parseSaveFile(parseJson(json));
}
