import type { GameState } from '../state/game-state.js';
import { migrateToCurrent } from './migrations.js';
import { GameStateV1Schema, type SaveFile, SaveFileSchema } from './schema.js';
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

export function fromSaveFile(raw: unknown): GameState {
  const file = SaveFileSchema.safeParse(raw);
  if (!file.success) {
    throw new SaveLoadError(`malformed save file: ${file.error.issues[0]?.message ?? 'unknown'}`);
  }
  const migrated = migrateToCurrent(file.data.state, file.data.version);
  const state = GameStateV1Schema.safeParse(migrated);
  if (!state.success) {
    const issue = state.error.issues[0];
    throw new SaveLoadError(
      `save state failed validation: ${issue?.path.join('.') ?? '(root)'} ${issue?.message ?? ''}`.trim(),
    );
  }
  return state.data;
}

export function deserializeSave(json: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SaveLoadError(`save file is not valid JSON: ${(error as Error).message}`);
  }
  return fromSaveFile(parsed);
}
