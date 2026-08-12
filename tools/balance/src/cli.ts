/**
 * `pnpm balance:sim` — runs the headless harness against the shipped content
 * and prints the phase timeline versus the spec §6 budget. Exits non-zero on a
 * budget violation so CI treats balance drift like a failing test.
 */
import { RAW_CONTENT, loadContent } from '@printhead/core';
import { findBot } from './bots.js';
import { buildBudgetTable, checkPhaseBudgets } from './budget.js';
import { runHeadless } from './harness.js';

function main(): void {
  const botId = process.argv[2] ?? 'budget-paced';
  const content = loadContent(RAW_CONTENT);
  const table = buildBudgetTable(content.pacing);
  const log = runHeadless({ content, bot: findBot(botId) });

  console.log(`bot: ${log.botId}`);
  console.log(
    `sim: ${log.ticks} ticks, ${log.designMinutes.toFixed(1)} design-min, ` +
      `${log.wallHours.toFixed(2)} wall-h at targetHours=${content.pacing.targetHours}`,
  );
  console.log('phase           actual   budget   window');
  for (const phase of table.phases) {
    const actual = log.phaseDurations.get(phase.phaseId);
    console.log(
      [
        phase.phaseId.padEnd(15),
        (actual === undefined ? '-' : actual.toFixed(1)).padStart(6),
        phase.budgetDesignMinutes.toFixed(1).padStart(8),
        `  ${phase.minDesignMinutes.toFixed(1)}..${phase.maxDesignMinutes.toFixed(1)}`,
      ].join(''),
    );
  }

  const violations = checkPhaseBudgets(table, log.phaseDurations);
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
