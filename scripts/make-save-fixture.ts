/**
 * Regenerates the current-version save fixture from a real simulation run, so
 * the corpus entry is a save the game actually produces rather than a
 * hand-written guess. Released fixtures are frozen: run this only when adding a
 * NEW version's fixture, never to "fix" an old one (spec §13, saves).
 *
 *   pnpm tsx scripts/make-save-fixture.ts
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Action, GameState } from '@printhead/core';
import {
  RAW_CONTENT,
  SAVE_SCHEMA_VERSION,
  TICK_MS,
  createInitialState,
  loadContent,
  reduce,
  restoreRng,
  toSaveFile,
} from '@printhead/core';

const content = loadContent(RAW_CONTENT);
const SAVED_AT_MS = 1_723_420_800_000;

let state: GameState = createInitialState(content, { seed: 20260812 });

const apply = (action: Action): void => {
  state = reduce(state, action, {
    content,
    nowMs: state.simTimeMs,
    rng: restoreRng(state.rng),
  });
};

const tickSeconds = (seconds: number): void => {
  for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i += 1) {
    apply({ type: 'TICK', simDtMs: TICK_MS });
  }
};

// Play the intro exactly as a player would, then run the bench loop a while.
for (const piece of content.start.assemblyPieces) {
  tickSeconds(piece.attachDesignSeconds);
  apply({ type: 'ATTACH_PIECE', pieceId: piece.id });
}
const slotId = `${content.start.slotIdPrefix}-1`;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
apply({ type: 'SET_SLOT_CONFIG', slotId, materialId, objectId });
apply({ type: 'START_PRINT', slotId });
tickSeconds(120);
apply({ type: 'SELL_PARTS', count: null });
tickSeconds(60);

const target = resolve(
  import.meta.dirname,
  `../packages/core/src/save/__fixtures__/save-v${SAVE_SCHEMA_VERSION}.json`,
);
writeFileSync(target, `${JSON.stringify(toSaveFile(state, SAVED_AT_MS), null, 2)}\n`);
console.log(`wrote ${target} (phase ${state.phaseId}, ${state.tickCount} ticks)`);
