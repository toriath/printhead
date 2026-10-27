/**
 * `pnpm balance:tune` — fit content fields until the phase budgets are met, and
 * write the winning values **back into `packages/core/content/*.json`** as a
 * data diff (spec §12.4, §19: "never into code").
 *
 *   pnpm balance:tune                      # fit the default knobs, dry run
 *   pnpm balance:tune --write              # ...and apply the patch
 *   pnpm balance:tune --phases intro,bench --knobs curves/printer-cost-tier1/base
 *   pnpm balance:tune --length-only        # phase budgets only, no fun penalties
 *
 * The write-back edits the JSON in place: it re-serialises the same object the
 * loader reads, so a tune is reviewable as `git diff packages/core/content`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_CONTENT, loadContent } from '@printhead/core';
import { PACING_BOTS, findBot } from './bots.js';
import { readPointer, writePointer } from './pointer.js';
import { type ClimbKnob, hillClimb, roundSignificant, scoreRun, withOverrides } from './tune.js';

const CONTENT_DIR = fileURLToPath(new URL('../../../packages/core/content/', import.meta.url));

/**
 * The knobs the fit is allowed to move, with the bounds it may not leave.
 * Deliberately a short, named list rather than "every number in content": an
 * optimiser handed the whole file will happily make PLA free to hit a budget.
 */
const DEFAULT_KNOBS: readonly ClimbKnob[] = [
  { pointer: 'start/assemblyPieces/*/attachDesignSeconds', min: 5, max: 120, integer: true },
  { pointer: 'curves/printer-cost-tier1/base', min: 5, max: 400 },
  { pointer: 'curves/printer-cost-tier1/growth', min: 1.02, max: 1.6 },
  { pointer: 'curves/upgrade-cost-machine/base', min: 5, max: 400 },
  { pointer: 'curves/automation-cost/base', min: 10, max: 2000 },
  { pointer: 'objects/gearset/partsYield', min: 1, max: 20, integer: true },
  // M4's new sinks. A config slot is the biggest single purchase before the
  // fork, so it owns a large slice of the farm phase's length (spec §4).
  { pointer: 'curves/slot-cost/base', min: 50, max: 4000 },
  // Spec §4 calls slot 3 "expensive": the growth floor is a *design* bound, not
  // a numerical one, and it stops the optimiser from buying a green timeline by
  // making the third bay a rounding error on the second.
  { pointer: 'curves/slot-cost/growth', min: 2.5, max: 12 },
  { pointer: 'curves/fork-cost/value', min: 100, max: 20000 },
  // M5's meta layer. The studio is gated on drafting the capstone, so what a
  // commission costs owns most of that phase; prestige is gated on the presses,
  // so the Plate reward, the press price and the print rate own that one.
  { pointer: 'curves/design-cost/base', min: 100, max: 40000 },
  { pointer: 'curves/design-cost/growth', min: 1.1, max: 8 },
  { pointer: 'curves/design-slot-cost/base', min: 100, max: 40000 },
  { pointer: 'curves/upgrade-cost-sla/base', min: 100, max: 8000 },
  { pointer: 'curves/prestige-plates/base', min: 0.1, max: 8 },
  { pointer: 'curves/money-printer-cost/base', min: 1, max: 60 },
  { pointer: 'curves/money-printer-cost/growth', min: 1.1, max: 8 },
  { pointer: 'curves/money-print-rate/step', min: 0.05, max: 40 },
  // M6's endgame. Phase 5 is paced by how fast the presses print (its gate is
  // a money-printed threshold) and by what the Endgame Tree costs in Plates;
  // phase 6 is paced almost entirely by the length of the final print.
  { pointer: 'curves/money-print-rate-bundles/step', min: 1, max: 4000 },
  { pointer: 'curves/endgame-node-cost/base', min: 1, max: 40 },
  // The upper press tiers were dead content (no bot ever bought one): their
  // prices are knobs so the fit can bring them within reach.
  { pointer: 'curves/money-printer-cost-bundles/base', min: 1, max: 40 },
  { pointer: 'curves/money-printer-cost-pallets/base', min: 2, max: 80 },
  { pointer: 'curves/money-printer-cost-central-bank/base', min: 4, max: 200 },
  { pointer: 'endgame/fabricator/designMinutes', min: 20, max: 55 },
  // A section must never take more off the final print than a quarter of
  // the room above the floor, or two of them flatten it (found that way).
  { pointer: 'endgame/fabricator/sectionDesignMinutes', min: 1, max: 5 },
  { pointer: 'pacing/phases/prestige/advanceWhen/2/atLeast', min: 10_000, max: 5_000_000 },
  // The prestige phase ends on Plates engraved, not melt-downs counted: a
  // player who melts early for a handful of Plates stays here until the pile is
  // big enough to buy the Absurd, instead of arriving there broke.
  { pointer: 'pacing/phases/prestige/advanceWhen/0/atLeast', min: 10, max: 160, integer: true },
  // The studio ends on Products sold; the knob is how long the design loop runs.
  { pointer: 'pacing/phases/studio/advanceWhen/2/atLeast', min: 20, max: 600, integer: true },
  // The Absurd ends on money earned this run from any source, so the knob is
  // the inflation the player has to live through (spec §6 phase 5).
  { pointer: 'pacing/phases/absurd/advanceWhen/2/atLeast', min: 100_000, max: 200_000_000 },
];

/**
 * Phases with real gates — since M6 that is every phase of the arc. The
 * terminal `ended` sandbox is not one of them: nothing ends it, so its
 * "duration" is however long the player stays and there is nothing to fit.
 */
const DEFAULT_PHASES = ['intro', 'bench', 'farm', 'studio', 'prestige', 'absurd', 'end'] as const;

function parseList(argv: readonly string[], flag: string): readonly string[] | undefined {
  const index = argv.indexOf(`--${flag}`);
  const value = index < 0 ? undefined : argv[index + 1];
  return value === undefined ? undefined : value.split(',').filter((entry) => entry.length > 0);
}

/** Which content file a pointer's first segment names. */
function fileOf(pointer: string): string {
  const head = pointer.split('/').filter((segment) => segment.length > 0)[0];
  if (head === undefined) {
    throw new Error(`cannot tell which file "${pointer}" belongs to`);
  }
  return head;
}

function applyToDisk(values: Readonly<Record<string, number>>): readonly string[] {
  const byFile = new Map<string, Record<string, number>>();
  for (const [pointer, value] of Object.entries(values)) {
    const file = fileOf(pointer);
    const bucket = byFile.get(file) ?? {};
    // Rounded on the way to disk, not during the search: the fit works in full
    // precision and the *diff* is what has to be legible.
    bucket[pointer] = roundSignificant(value);
    byFile.set(file, bucket);
  }
  const written: string[] = [];
  for (const [file, patches] of byFile) {
    const path = join(CONTENT_DIR, `${file}.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    // Pointers are absolute (`curves/…`), so wrap the file back under its name.
    const wrapper: Record<string, unknown> = { [file]: parsed };
    for (const [pointer, value] of Object.entries(patches)) {
      writePointer(wrapper, pointer, value);
    }
    writeFileSync(path, `${JSON.stringify(wrapper[file], null, 2)}\n`);
    written.push(`${file}.json`);
  }
  return written;
}

function main(): void {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const botId = parseList(argv, 'bot')?.[0];
  const phaseIds = parseList(argv, 'phases') ?? [...DEFAULT_PHASES];
  const knobPointers = parseList(argv, 'knobs');
  const knobs =
    knobPointers === undefined
      ? DEFAULT_KNOBS
      : knobPointers.map((pointer) => {
          const known = DEFAULT_KNOBS.find((knob) => knob.pointer === pointer);
          if (known !== undefined) {
            return known;
          }
          const current = readPointer(RAW_CONTENT, pointer)[0] ?? 1;
          return { pointer, min: current / 10, max: current * 10 };
        });

  // One named bot fits that bot; otherwise the fit is scored across the whole
  // pacing roster, the same set the CI gate holds to the budget.
  const bots = botId === undefined ? PACING_BOTS : [findBot(botId)];
  // Fun penalties are on unless asked off: a fit that only hits the clock is the
  // failure mode this tool exists to avoid.
  const fun = !argv.includes('--length-only');
  const before = scoreRun(RAW_CONTENT, phaseIds, { bots, fun });

  console.log(
    `tuning ${knobs.length} knob(s) against ${phaseIds.join(', ')} ` +
      `for ${bots.map((b) => b.id).join(' + ')}`,
  );
  console.log(`start score ${before.score.toFixed(4)}`);

  const result = hillClimb({
    raw: RAW_CONTENT,
    knobs,
    phaseIds,
    bots,
    fun,
  });

  const budgets = loadContent(RAW_CONTENT).pacing.phases;
  console.log(`\nafter ${result.evaluations} evaluation(s): score ${result.score.toFixed(4)}\n`);
  console.log(`phase          ${bots.map((b) => b.id.padStart(16)).join('')}   budget`);
  for (const phaseId of phaseIds) {
    const budget = budgets.find((phase) => phase.id === phaseId)?.budgetDesignMinutes ?? 0;
    const actuals = bots
      .map((b) =>
        (result.phaseDurations[`${b.id}/${phaseId}`] ?? Number.NaN).toFixed(1).padStart(16),
      )
      .join('');
    console.log(`${phaseId.padEnd(15)}${actuals}${budget.toFixed(1).padStart(9)}`);
  }

  console.log('\nfield                                              from        to');
  for (const knob of knobs) {
    const from = readPointer(RAW_CONTENT, knob.pointer)[0] ?? Number.NaN;
    const to = result.values[knob.pointer] ?? from;
    console.log(
      `${knob.pointer.padEnd(50)}${from.toFixed(4).padStart(10)}${to.toFixed(4).padStart(10)}`,
    );
  }

  // Re-validate before touching disk: a fit that produces invalid content is a
  // bug in the bounds, not a balance change.
  loadContent(withOverrides(RAW_CONTENT, result.values));

  if (!write) {
    console.log('\ndry run — pass --write to apply the patch to packages/core/content');
    return;
  }
  const files = applyToDisk(result.values);
  console.log(`\nwrote ${files.join(', ')}`);
}

main();
