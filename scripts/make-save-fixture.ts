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
  countPrinters,
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

/*
 * The M5 state — Designs owned and levelling, a bay making Products, a
 * commission on the studio bench, Plates on the books, a press installed and an
 * intro that rebuilds itself — needs the run to have been *melted down*, which
 * is another eighty design-minutes of economy away. The reference bot is handed
 * the wheel again as far as the melt-down phase; the M5 decisions after that go
 * through the real reducer, exactly as the M4 ones did.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'prestige', seed: 7 }).finalState;
apply({ type: 'PRESTIGE' });

/**
 * Parts and Money handed to the rebuilt workshop. A melt-down leaves a bare
 * bench (that is the point), and grinding the whole studio back up a second
 * time would double the generator's runtime for no extra coverage. Every action
 * below still goes through the real reducer and its real availability rules, so
 * the state it produces is one the game can reach.
 */
const REBUILD_FIXTURE_PARTS = 4000;
const REBUILD_FIXTURE_MONEY = 400_000;

// Let the workshop rebuild itself (spec §6 phase 4) — the pieces clip on with
// no clicks at all, which is the whole point of `selfAssembling`. The first one
// waits out the melt-down on top of its own bench time, so this waits for the
// *state* rather than counting seconds.
const pieceCount = content.start.assemblyPieces.length;
for (let second = 0; second < MAX_GRIND_SECONDS; second += 1) {
  if (state.assembly.attachedPieceIds.length >= pieceCount) {
    break;
  }
  tickSeconds(1);
}
state = {
  ...state,
  resources: {
    ...state.resources,
    parts: state.resources.parts + REBUILD_FIXTURE_PARTS,
    money: state.resources.money + REBUILD_FIXTURE_MONEY,
  },
};

// The resin gate of spec §3, re-earned: a Design cannot be printed until the
// machine tree opens the material it names.
for (const upgradeId of ['heated-bed', 'enclosure', 'sla-unit', 'design-desk', 'design-desk']) {
  apply({ type: 'BUY_UPGRADE', upgradeId });
}
const press = content.prestige.moneyPrinters[0];
if (press !== undefined) {
  apply({ type: 'BUY_MONEY_PRINTER', moneyPrinterId: press.id });
}
const capstone = content.designs.find((def) => def.id === content.prestige.requiredDesignId);
const firstBay = state.slots[0];
if (capstone !== undefined && firstBay !== undefined) {
  apply({ type: 'BUY_FILAMENT', materialId: capstone.requiredMaterialId, grams: 2000 });
  apply({ type: 'SET_SLOT_DESIGN', slotId: firstBay.id, designId: capstone.id });
  apply({ type: 'START_PRINT', slotId: firstBay.id });
  // Long enough for the batch to land, so the save carries Products *and* the
  // banked value they were worth at the level their Design had reached.
  tickSeconds(capstone.printDesignSeconds * 3);
}
// A commission on the bench: `studio` is the one nullable new field a save can
// carry mid-flight, and a fixture that never populated it would not prove the
// migration writes it.
const spare = content.designs.find((def) => state.designs[def.id] === undefined);
if (spare !== undefined) {
  apply({ type: 'CREATE_DESIGN', designId: spare.id });
  tickSeconds(30);
}

/*
 * The M6 state — an Endgame Tree bought with Plates, a printed factory turning
 * over, sections pre-printed for the Fabricator and the final print itself in
 * flight — sits behind two more phases of economy. The reference bot is handed
 * the wheel one last time, as far as the phase that allows the print, and the
 * M6 decisions after that go through the real reducer exactly as the M4 and M5
 * ones did.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'end', seed: 7 }).finalState;

/**
 * Plates and Parts handed to the workshop so the last print can be captured in
 * flight. A *fixture* concession like the rebuild grant above: every action
 * below still goes through the real reducer and its real availability rules.
 */
const ENDGAME_FIXTURE_PLATES = 40;
const ENDGAME_FIXTURE_PARTS = 5000;
state = {
  ...state,
  resources: {
    ...state.resources,
    plates: state.resources.plates + ENDGAME_FIXTURE_PLATES,
    parts: state.resources.parts + ENDGAME_FIXTURE_PARTS,
  },
};
const fabricator = content.endgame.fabricator;
for (const def of content.upgrades) {
  if (def.tree === 'endgame' && state.upgrades[def.id] === undefined) {
    apply({ type: 'BUY_UPGRADE', upgradeId: def.id });
  }
}
const finalFork = content.forks.find((def) => def.requiredForFinalPrint);
if (finalFork !== undefined && state.forkId === null) {
  apply({ type: 'CHOOSE_FORK', forkId: finalFork.id });
}
apply({
  type: 'BUY_FILAMENT',
  materialId: fabricator.materialId,
  grams: fabricator.filamentGrams + fabricator.sectionFilamentGrams,
});
// One pre-printed section, so the fixture carries the §7.3 state as well.
apply({ type: 'PRINT_SECTION' });
tickSeconds(fabricator.sectionDesignMinutes * 60 + 1);
const finalBay = state.slots[0];
while (finalBay !== undefined && countPrinters(state) < fabricator.requiredPrinters) {
  apply({ type: 'BUY_PRINTER', printerId: content.start.printerId, slotId: finalBay.id });
}
apply({ type: 'START_FABRICATOR' });
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
