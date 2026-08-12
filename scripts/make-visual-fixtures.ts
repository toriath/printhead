/**
 * Regenerates the *reachable* `VisualState` fixtures by playing the real
 * simulation and projecting it, so each fixture is a snapshot the game actually
 * produces rather than a hand-written guess (spec §13, renderer row).
 *
 *   pnpm tsx scripts/make-visual-fixtures.ts
 *
 * Fixtures for a *released* VisualState version are frozen — see the README in
 * `packages/core/src/visual/__fixtures__/`. Run this when adding a new version.
 * `showcase.json` is hand-authored and is deliberately not written here.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REFERENCE_BOT, runHeadless } from '@printhead/balance';
import type { Action, GameState, VisualState } from '@printhead/core';
import {
  RAW_CONTENT,
  TICK_MS,
  createInitialState,
  loadContent,
  reduce,
  restoreRng,
  toVisualState,
} from '@printhead/core';

const content = loadContent(RAW_CONTENT);
/** Parts handed to the workshop so the fork fixture can be captured. */
const FORK_FIXTURE_PARTS = 5000;
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

const dir = resolve(import.meta.dirname, '../packages/core/src/visual/__fixtures__');
const written: string[] = [];

const capture = (name: string): void => {
  const visual: VisualState = toVisualState(state, content);
  writeFileSync(resolve(dir, `${name}.json`), `${JSON.stringify(visual, null, 2)}\n`);
  written.push(`${name} (phase ${visual.phaseId}, ${visual.slots.length} slot(s))`);
};

// 1. A brand-new save: bare bench, nothing attached.
capture('fresh');

// 2. Mid-intro: three pieces on, the fourth still cooling down.
const pieces = content.start.assemblyPieces;
for (const piece of pieces.slice(0, 3)) {
  tickSeconds(piece.attachDesignSeconds);
  apply({ type: 'ATTACH_PIECE', pieceId: piece.id });
}
tickSeconds((pieces[3]?.attachDesignSeconds ?? 0) / 2);
capture('assembling');

// 3. Printer #1 exists but no config is loaded yet — an empty staffed bay.
for (const piece of pieces.slice(3)) {
  tickSeconds(piece.attachDesignSeconds);
  apply({ type: 'ATTACH_PIECE', pieceId: piece.id });
}
capture('assembled');

// 4. The first batch, halfway through, with parts and money on the books.
const slotId = `${content.start.slotIdPrefix}-1`;
const materialId = content.materials[0]?.id ?? 'pla';
const objectId = content.objects[0]?.id ?? 'bracket';
apply({ type: 'SET_SLOT_CONFIG', slotId, materialId, objectId });
apply({ type: 'START_PRINT', slotId });
tickSeconds((content.objects[0]?.printDesignSeconds ?? 0) * 2);
apply({ type: 'SELL_PARTS', count: null });
tickSeconds((content.objects[0]?.printDesignSeconds ?? 0) / 2);
capture('printing');

/**
 * 5. The M3 workshop: a machine node installed, an automation running, a scrap
 * bin waiting for the recycler and a slot mid-purge. Reached by *playing*, not
 * by hand-editing state — the point of a fixture is that the sim can produce it.
 */
const grind = (until: () => boolean, limitSeconds = 3600): void => {
  const perPrint = content.objects.find((object) => object.id === objectId)?.filamentGrams ?? 1;
  for (let second = 0; second < limitSeconds && !until(); second += 1) {
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

grind(() => state.phaseId !== 'intro');
grind(() => state.resources.parts >= 200);
apply({ type: 'BUY_UPGRADE', upgradeId: 'heated-bed' });
apply({ type: 'BUY_UPGRADE', upgradeId: content.failure.recycler.requiresUpgradeId });
grind(() => state.resources.parts >= 400);
apply({ type: 'BUY_AUTOMATION', automationId: content.automation[0]?.id ?? 'auto-sell' });
grind(() => state.resources.scrap > 0);
// Switch to the material the heated bed unlocked: a real changeover, mid-purge.
apply({ type: 'BUY_FILAMENT', materialId: 'petg', grams: 200 });
apply({ type: 'SET_SLOT_CONFIG', slotId, materialId: 'petg', objectId });
tickSeconds(5);
capture('economy');

/**
 * 6. The M4 rack: two bays, the fleet split between them, and a print rota on
 * the second. Reached by handing the wheel to the reference bot until the phase
 * where the fork unlocks — the farm gate is a grind, not a click, and a fixture
 * that skipped it would be a hand-written guess again.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'studio', seed: 7 }).finalState;
for (const slot of state.slots) {
  apply({ type: 'SET_SLOT_CONFIG', slotId: slot.id, materialId, objectId });
}
const rota = content.automation.find((def) => def.behavior === 'auto-changeover');
const second = state.slots[1];
if (rota !== undefined && second !== undefined) {
  apply({
    type: 'SET_SLOT_QUEUE',
    slotId: second.id,
    entries: [
      { materialId, objectId, batches: 4 },
      { materialId: 'petg', objectId, batches: 4 },
    ],
  });
}
tickSeconds(5);
capture('rack');

/**
 * 7. The Goliath (spec §5B): the same workshop after the fork melts the rack
 * into one machine. Captured straight after the commitment so the fixture shows
 * what the renderer must switch to — a single, much larger printer.
 */
const goliath = content.forks.find((def) => def.visual === 'goliath');
if (goliath !== undefined) {
  state = {
    ...state,
    // The commitment costs Parts the bot has not banked at this exact moment;
    // granting them is a *fixture* concession, not a rule change — the action
    // below still goes through the real reducer and the real availability
    // rules, so the state it produces is one the game can reach.
    resources: { ...state.resources, parts: state.resources.parts + FORK_FIXTURE_PARTS },
  };
  apply({ type: 'CHOOSE_FORK', forkId: goliath.id });
  tickSeconds(5);
  capture('goliath');
}

console.log(`wrote ${written.length} fixtures to ${dir}:`);
for (const line of written) {
  console.log(`  - ${line}`);
}
