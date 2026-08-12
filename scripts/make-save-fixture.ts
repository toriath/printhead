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
/** Any grind loop needs a stop: a fixture generator must never hang CI. */
const MAX_GRIND_SECONDS = 3600;

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

const slotId = `${content.start.slotIdPrefix}-1`;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';

/**
 * Run the loop until `ready` holds, or give up. Parts are only cashed in when
 * the spool runs dry — selling everything every second would keep the parts
 * balance at zero and no "grind until you can afford it" would ever finish.
 */
const grindUntil = (ready: () => boolean): void => {
  const perPrint = content.objects.find((object) => object.id === objectId)?.filamentGrams ?? 1;
  for (let second = 0; second < MAX_GRIND_SECONDS && !ready(); second += 1) {
    tickSeconds(1);
    if ((state.filamentGrams[materialId] ?? 0) < perPrint) {
      apply({ type: 'SELL_PARTS', count: Math.ceil(state.resources.parts / 2) });
      const grams = Math.floor(state.resources.money / (content.materials[0]?.costPerGram ?? 1));
      if (grams > 0) {
        apply({ type: 'BUY_FILAMENT', materialId, grams });
      }
    }
  }
};

// Play the intro exactly as a player would, then run the bench loop a while.
for (const piece of content.start.assemblyPieces) {
  tickSeconds(piece.attachDesignSeconds);
  apply({ type: 'ATTACH_PIECE', pieceId: piece.id });
}
apply({ type: 'SET_SLOT_CONFIG', slotId, materialId, objectId });
apply({ type: 'START_PRINT', slotId });
tickSeconds(120);
apply({ type: 'SELL_PARTS', count: null });
tickSeconds(60);

// Then exercise the M3 mechanics so the fixture carries the state they add:
// an installed machine node, a recycler run, and a live automation.
const recyclerId = content.failure.recycler.requiresUpgradeId;
grindUntil(() => state.resources.parts >= 60);
apply({ type: 'BUY_UPGRADE', upgradeId: recyclerId });
grindUntil(() => state.resources.scrap > 0);
apply({ type: 'RECYCLE_SCRAP', materialId, grams: null });
const automationId = content.automation[0]?.id;
if (automationId !== undefined) {
  grindUntil(() => state.resources.parts >= 200);
  apply({ type: 'BUY_AUTOMATION', automationId });
  apply({ type: 'SET_AUTOMATION', automationId, threshold: 25 });
}
tickSeconds(60);

const target = resolve(
  import.meta.dirname,
  `../packages/core/src/save/__fixtures__/save-v${SAVE_SCHEMA_VERSION}.json`,
);
writeFileSync(target, `${JSON.stringify(toSaveFile(state, SAVED_AT_MS), null, 2)}\n`);
console.log(
  `wrote ${target} (phase ${state.phaseId}, ${state.tickCount} ticks, ` +
    `${Object.keys(state.upgrades).length} upgrade(s), ` +
    `${Object.keys(state.automation).length} automation(s))`,
);
