/**
 * `pnpm balance:sim` — runs the headless harness against the shipped content
 * and prints the phase timeline versus the spec §6 budget. Exits non-zero on a
 * budget violation so CI treats balance drift like a failing test.
 *
 *   pnpm balance:sim [botId]
 */
import { RAW_CONTENT, loadContent } from '@printhead/core';
import { REFERENCE_BOT, findBot } from './bots.js';
import { buildBudgetTable, checkPhaseBudgets } from './budget.js';
import { type RunLog, runHeadless } from './harness.js';

function printTimeline(log: RunLog, content: ReturnType<typeof loadContent>): void {
  const table = buildBudgetTable(content.pacing);
  console.log('phase           actual   budget   window          decisions');
  for (const phase of table.phases) {
    const actual = log.phaseDurations.get(phase.phaseId);
    console.log(
      [
        phase.phaseId.padEnd(15),
        (actual === undefined ? '-' : actual.toFixed(1)).padStart(6),
        phase.budgetDesignMinutes.toFixed(1).padStart(9),
        `   ${phase.minDesignMinutes.toFixed(1)}..${phase.maxDesignMinutes.toFixed(1)}`.padEnd(16),
        String(log.decisionsByPhase.get(phase.phaseId) ?? 0).padStart(9),
      ].join(''),
    );
  }
}

function printCurves(log: RunLog): void {
  console.log('\nresource curves (design-min: parts / money / filament / printers / prints)');
  const step = Math.max(1, Math.floor(log.samples.length / 12));
  for (let i = 0; i < log.samples.length; i += step) {
    const s = log.samples[i];
    if (s === undefined) {
      continue;
    }
    console.log(
      `  ${s.designMinutes.toFixed(1).padStart(6)}  ${s.parts.toFixed(0).padStart(7)} ` +
        `${s.money.toFixed(1).padStart(9)} ${s.filamentGrams.toFixed(0).padStart(8)} ` +
        `${String(s.printers).padStart(5)} ${String(s.printsCompleted).padStart(7)}`,
    );
  }
}

function main(): void {
  const botId = process.argv[2];
  const content = loadContent(RAW_CONTENT);
  const bot = botId === undefined ? REFERENCE_BOT : findBot(botId);
  const log = runHeadless({ content, bot });

  console.log(`bot: ${log.botId}`);
  console.log(
    `sim: ${log.ticks} ticks, ${log.designMinutes.toFixed(1)} design-min, ` +
      `${log.wallHours.toFixed(2)} wall-h at targetHours=${content.pacing.targetHours}`,
  );
  console.log(
    `decisions: ${log.decisions}, actions: ${log.actions} ` +
      `(${Object.entries(log.actionsByType)
        .map(([type, count]) => `${type}×${count}`)
        .join(', ')})`,
  );
  console.log('');
  printTimeline(log, content);
  printCurves(log);

  const violations = checkPhaseBudgets(buildBudgetTable(content.pacing), log.phaseDurations);
  if (violations.length > 0) {
    console.error(`\n${violations.length} budget violation(s):`);
    for (const violation of violations) {
      console.error(
        `  ${violation.phaseId}: ${violation.reason} ` +
          `(${violation.actualDesignMinutes.toFixed(1)} vs ${violation.budgetDesignMinutes})`,
      );
    }
    process.exit(1);
  }
  console.log('\nbalance: OK — all phases within tolerance');
}

main();
