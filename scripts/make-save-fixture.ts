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
import { REFERENCE_BOT, runHeadless } from '@printhead/balance';
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
/** Parts cashed in per restock while saving up — small, so savings still grow. */
const RESTOCK_PARCEL_PARTS = 20;

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

/*
 * The M4 state — a second bay, a fleet spread across it, a print rota and the
 * run's Farm/Goliath commitment — sits behind the farm gate, which is a long
 * grind rather than a few clicks. Rather than hand-write it (the one thing a
 * fixture must not be), hand the wheel to the reference bot until the phase
 * that unlocks the fork, then make the M4 decisions through the same reducer.
 */
const handover = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'studio', seed: 7 });
state = handover.finalState;

const rota = content.automation.find((def) => def.behavior === 'auto-changeover');
if (rota !== undefined && state.automation[rota.id] === undefined) {
  grindUntil(() => state.resources.parts >= 400);
  apply({ type: 'BUY_AUTOMATION', automationId: rota.id });
}
/*
 * Put the rack back on PLA before saving up for the fork. By the time the bot
 * hands over it has drained the PETG shelf, and a market-priced material
 * restocks at a fixed rate (spec §7.2) — so a workshop of fourteen printers on
 * PETG produces at the shelf's pace, not its own, and would never bank the
 * 1 200 Parts the commitment costs. PLA is the infinite one; that is its whole
 * identity (spec §3).
 */
for (const slot of state.slots) {
  apply({ type: 'SET_SLOT_CONFIG', slotId: slot.id, materialId, objectId });
}

const petg = content.materials.find((material) => material.id === 'petg');
const second = state.slots[1];
if (rota !== undefined && petg !== undefined && second !== undefined) {
  apply({
    type: 'SET_SLOT_QUEUE',
    slotId: second.id,
    entries: [
      { materialId, objectId, batches: 4 },
      { materialId: petg.id, objectId, batches: 4 },
    ],
  });
}
/**
 * Keep every bay fed, whatever it happens to be loaded with. The single-slot
 * grind above cannot do this: it only ever tops up the material the *first*
 * bay started with, which by now is not what the rack is printing.
 */
const runRack = (ready: () => boolean): void => {
  for (let second = 0; second < MAX_GRIND_SECONDS && !ready(); second += 1) {
    tickSeconds(1);
    for (const slot of state.slots) {
      const material = content.materials.find((entry) => entry.id === slot.materialId);
      const object = content.objects.find((entry) => entry.id === slot.objectId);
      if (material === undefined || object === undefined) {
        continue;
      }
      const need = object.filamentGrams * Math.max(slot.printerCount, 1);
      if ((state.filamentGrams[material.id] ?? 0) >= need) {
        continue;
      }
      // Sell a small parcel, not a quarter of the tin: the point of this grind
      // is to *accumulate* Parts for the fork, and a big sale every second
      // would hold the balance flat forever.
      apply({ type: 'SELL_PARTS', count: Math.min(state.resources.parts, RESTOCK_PARCEL_PARTS) });
      const grams = Math.floor(state.resources.money / Math.max(material.costPerGram, 0.01));
      if (grams > 0) {
        apply({ type: 'BUY_FILAMENT', materialId: material.id, grams: Math.min(grams, need * 20) });
      }
    }
  }
};

// The Farm branch keeps the rack (and the rota with it), so the fixture can
// carry both the fork and a multi-bay workshop. The auto-seller has to be told
// what the workshop is saving for, or it cashes the fork fund in as fast as the
// printers make it.
const forkTarget = 1200;
for (const def of content.automation) {
  if (def.behavior === 'sell-parts' && state.automation[def.id] !== undefined) {
    apply({ type: 'SET_AUTOMATION', automationId: def.id, threshold: forkTarget });
  }
}
runRack(() => state.resources.parts >= forkTarget);
apply({ type: 'CHOOSE_FORK', forkId: 'farm-path' });
tickSeconds(30);

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
