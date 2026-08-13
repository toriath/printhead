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
  SECONDS_PER_MINUTE,
  TICK_MS,
  countPrinters,
  createCurveRegistry,
  createInitialState,
  loadContent,
  nextAutomationCost,
  nextPrinterCost,
  nextUpgradeCost,
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

/**
 * Everything below is priced from the *current* content rather than from a
 * number typed here. A re-balance moves these costs by hundreds of Parts, and a
 * fixture generator that grinds to a hard-coded target quietly starts producing
 * a workshop with no automation in it — which is exactly what this fixture
 * exists to pin.
 */
const curves = createCurveRegistry(content.curves);
const afford = (amount: number): void => grind(() => state.resources.parts >= amount);

// A few more machines first: one printer cannot earn its way to a machine node
// inside the generator's grind budget, and a player would not try.
const printer = content.printers[0];
for (let i = 0; printer !== undefined && i < 3; i += 1) {
  afford(nextPrinterCost(state, content, curves, printer.id)?.amount ?? 0);
  apply({ type: 'BUY_PRINTER', printerId: printer.id, slotId });
}

for (const upgradeId of ['heated-bed', content.failure.recycler.requiresUpgradeId]) {
  afford(nextUpgradeCost(state, content, curves, upgradeId)?.amount ?? 0);
  apply({ type: 'BUY_UPGRADE', upgradeId });
}

const firstAutomation = content.automation[0];
if (firstAutomation !== undefined) {
  afford(nextAutomationCost(state, content, curves, firstAutomation.id)?.amount ?? 0);
  apply({ type: 'BUY_AUTOMATION', automationId: firstAutomation.id });
}

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

/**
 * 8. The Design Studio (spec §5D). Handing the wheel to the reference bot as
 * far as the melt-down phase is the only honest way to reach it: the capstone
 * sits behind resin, forty sold Products and a second commission, which is
 * eighty design-minutes of economy rather than a few clicks.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'prestige', seed: 7 }).finalState;
tickSeconds(5);
capture('studio');

/**
 * 9. After the melt-down (spec §6 phase 4): Plates on the books, a press
 * installed, the Designs still owned at the level they reached, and an intro
 * that rebuilds itself. Run on to the phase after prestige so the projection
 * carries a workshop that has actually been melted down and started again.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'absurd', seed: 7 }).finalState;
tickSeconds(5);
capture('prestige');

/**
 * 10. The endgame (spec §5E, §6 phase 5): the Endgame Tree bought with Plates,
 * the printed city behind the rack, and the on-screen inflation the presses
 * caused. Reached by handing the wheel to the reference bot as far as the last
 * phase, which is the only honest way to arrive with a Plate economy.
 */
state = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'end', seed: 7 }).finalState;
tickSeconds(5);
capture('endgame');

/**
 * 11. The one synced render (spec §6 phase 6): the Universal Fabricator, half
 * printed. The workshop is handed the Plates and Parts the last print needs —
 * a *fixture* concession, like the fork above — and every action after that
 * goes through the real reducer and its real availability rules.
 */
const FABRICATOR_FIXTURE_PLATES = 40;
const FABRICATOR_FIXTURE_PARTS = 5000;
const fabricator = content.endgame.fabricator;
const goliathFork = content.forks.find((def) => def.requiredForFinalPrint);
state = {
  ...state,
  resources: {
    ...state.resources,
    plates: state.resources.plates + FABRICATOR_FIXTURE_PLATES,
    parts: state.resources.parts + FABRICATOR_FIXTURE_PARTS,
  },
};
if (goliathFork !== undefined && state.forkId === null) {
  apply({ type: 'CHOOSE_FORK', forkId: goliathFork.id });
}
apply({ type: 'BUY_FILAMENT', materialId: fabricator.materialId, grams: fabricator.filamentGrams });
const bay = state.slots[0];
while (bay !== undefined && countPrinters(state) < fabricator.requiredPrinters) {
  apply({ type: 'BUY_PRINTER', printerId: content.start.printerId, slotId: bay.id });
}
// A section may still be on the bed — the bot pre-prints them (spec §7.3) —
// and the Fabricator will not start over the top of one. Wait it out rather
// than issuing an action the reducer is right to refuse.
while (state.fabricator.sectionRun !== null) {
  tickSeconds(1);
}
apply({ type: 'START_FABRICATOR' });
tickSeconds((fabricator.designMinutes * SECONDS_PER_MINUTE) / 2);
capture('fabricator');

/**
 * 12. The credits, printing out (spec §6 phase 6). The build is run to the end
 * and the clock carried past the museum shot, so the fixture catches the stage
 * the renderer has the most to draw in.
 */
const ending = content.endgame.ending;
// The rest of the build — however long it has left, since a pre-printed
// section shortens it (spec §7.3) — then the numbers and the museum shot, and
// halfway into the credits: the stage with the most for the renderer to draw.
while (state.fabricator.run !== null) {
  tickSeconds(1);
}
tickSeconds(
  ending.numbersDesignSeconds + ending.museumDesignSeconds + ending.creditsDesignSeconds / 2,
);
capture('ending');

console.log(`wrote ${written.length} fixtures to ${dir}:`);
for (const line of written) {
  console.log(`  - ${line}`);
}
