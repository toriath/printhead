import { type GameState, SaveLoadError, parseSave, serializeSave } from '@printhead/core';
import type { Storage } from '@printhead/platform';

/**
 * Saving and loading, app side (Memento, spec §15). `core` owns the schema, the
 * migrations and the validation; this file only decides *where* the bytes go
 * and what to do when they come back broken.
 */
export const SAVE_KEY = 'printhead/save';

export interface LoadedGame {
  readonly state: GameState;
  readonly savedAtMs: number;
  readonly fromVersion: number;
}

export type LoadFailure =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly message: string };

export type LoadOutcome = { readonly kind: 'loaded'; readonly save: LoadedGame } | LoadFailure;

export interface SaveIo {
  readonly storage: Storage;
  readonly key?: string;
}

export async function writeSave(io: SaveIo, state: GameState, nowMs: number): Promise<void> {
  await io.storage.write(io.key ?? SAVE_KEY, serializeSave(state, nowMs));
}

export async function clearSave(io: SaveIo): Promise<void> {
  await io.storage.remove(io.key ?? SAVE_KEY);
}

/**
 * Never throws. A corrupt save is a bad day, not a crash: the caller starts a
 * fresh game and the outcome says why, so the shell can say so out loud rather
 * than silently pretending the player is new.
 */
export async function readSave(io: SaveIo): Promise<LoadOutcome> {
  let raw: string | null;
  try {
    raw = await io.storage.read(io.key ?? SAVE_KEY);
  } catch (error) {
    return { kind: 'unreadable', message: describe(error) };
  }
  if (raw === null) {
    return { kind: 'absent' };
  }
  try {
    return { kind: 'loaded', save: parseSave(raw) };
  } catch (error) {
    return { kind: 'unreadable', message: describe(error) };
  }
}

function describe(error: unknown): string {
  if (error instanceof SaveLoadError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
