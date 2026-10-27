/**
 * `pnpm balance:report` — run every bot against the shipped content and write a
 * markdown report with SVG charts into `docs/balance-reports/<date>/`
 * (spec §12.5). Every balance PR attaches one.
 *
 *   pnpm balance:report              # dated directory
 *   pnpm balance:report --date 2026-08-12
 *   pnpm balance:report --sweep /tmp/sweep.csv
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAW_CONTENT, loadContent } from '@printhead/core';
import { BOTS, REFERENCE_BOT } from './bots.js';
import { runHeadless } from './harness.js';
import { HUMAN_LIMIT_DESIGN_MINUTES, HUMAN_SEEDS, createHumanBot } from './human.js';
import { buildReport } from './report.js';

const REPORTS_DIR = fileURLToPath(new URL('../../../docs/balance-reports/', import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function main(): void {
  const content = loadContent(RAW_CONTENT);
  // The report's date is an input, not a `Date.now()` call, so regenerating a
  // report for a past run produces byte-identical output.
  const date = flag('date') ?? new Date().toISOString().slice(0, 10);

  const logs = BOTS.map((bot) => {
    console.error(`running ${bot.id}…`);
    return runHeadless({ content, bot });
  });

  const crowd = HUMAN_SEEDS.map((seed) => {
    const bot = createHumanBot(seed);
    console.error(`running ${bot.id}…`);
    return runHeadless({ content, bot, limitDesignMinutes: HUMAN_LIMIT_DESIGN_MINUTES });
  });

  const sweepPath = flag('sweep');
  const files = buildReport({
    content,
    logs,
    referenceBotId: REFERENCE_BOT.id,
    date,
    crowd,
    ...(sweepPath === undefined ? {} : { sweepCsv: readFileSync(sweepPath, 'utf8') }),
  });
  const target = join(REPORTS_DIR, date);
  mkdirSync(target, { recursive: true });
  for (const file of files) {
    writeFileSync(join(target, file.name), file.contents);
  }
  console.log(`wrote ${files.length} file(s) to docs/balance-reports/${date}/`);
}

main();
