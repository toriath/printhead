import type { Content } from '@printhead/core';
import { type BudgetTable, buildBudgetTable, checkPhaseBudgets, gatedPhaseIds } from './budget.js';
import type { RunLog } from './harness.js';
import { type BarRow, barChart, lineChart } from './svg.js';
import { checkWaitWalls, longestWallByPhase } from './waitwall.js';

/**
 * Report generator (spec §12.5): markdown plus SVG charts, written into
 * `docs/balance-reports/<date>/`. Every balance PR attaches one, which is what
 * makes a data diff reviewable — the numbers moved *and here is what happened*.
 *
 * This module only builds the files; writing them is the CLI's job, so the
 * whole generator is testable without touching a disk.
 */
export interface ReportFile {
  readonly name: string;
  readonly contents: string;
}

export interface ReportInput {
  readonly content: Content;
  readonly logs: readonly RunLog[];
  /** The bot the CI gate measures; its charts lead the report. */
  readonly referenceBotId: string;
  /** ISO date the report is filed under. Injected — core forbids clocks. */
  readonly date: string;
  /** Optional sweep output to attach alongside. */
  readonly sweepCsv?: string;
}

const CURVES = [
  { key: 'parts', title: 'Parts in stock', unit: 'parts' },
  { key: 'money', title: 'Money', unit: 'money' },
  { key: 'filamentGrams', title: 'Filament in stock', unit: 'grams' },
  { key: 'printers', title: 'Printers owned', unit: 'machines' },
  { key: 'printsCompleted', title: 'Prints completed', unit: 'prints' },
] as const;

function timelineRows(table: BudgetTable, log: RunLog): readonly BarRow[] {
  return table.phases.map((phase) => {
    const actual = log.phaseDurations.get(phase.phaseId);
    const reached = actual !== undefined;
    const ok = reached && actual >= phase.minDesignMinutes && actual <= phase.maxDesignMinutes;
    return {
      label: phase.name,
      value: actual ?? 0,
      target: phase.budgetDesignMinutes,
      min: phase.minDesignMinutes,
      max: phase.maxDesignMinutes,
      ok,
      note: reached
        ? `${actual.toFixed(1)} / ${phase.budgetDesignMinutes} · ${ok ? 'OK' : 'OVER'}`
        : 'not reached',
    };
  });
}

function wallRows(content: Content, log: RunLog): readonly BarRow[] {
  const longest = longestWallByPhase(log.waitWalls);
  return content.pacing.phases.map((phase) => {
    const worst = longest.get(phase.id) ?? 0;
    const ok = worst <= phase.waitWallBudgetDesignMinutes;
    return {
      label: phase.name,
      value: worst,
      target: phase.waitWallBudgetDesignMinutes,
      min: 0,
      max: phase.waitWallBudgetDesignMinutes,
      ok,
      note: `${worst.toFixed(1)} / ${phase.waitWallBudgetDesignMinutes} · ${ok ? 'OK' : 'OVER'}`,
    };
  });
}

function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function summaryTable(table: BudgetTable, logs: readonly RunLog[]): string {
  const header = ['Phase', 'Budget', ...logs.map((log) => log.botId)];
  const rows = table.phases.map((phase) => [
    phase.name,
    `${phase.budgetDesignMinutes} (${phase.minDesignMinutes.toFixed(0)}–${phase.maxDesignMinutes.toFixed(0)})`,
    ...logs.map((log) => {
      const actual = log.phaseDurations.get(phase.phaseId);
      return actual === undefined ? '—' : actual.toFixed(1);
    }),
  ]);
  rows.push([
    '**Total**',
    `**${table.totalDesignMinutes}**`,
    ...logs.map((log) => `**${log.designMinutes.toFixed(1)}**`),
  ]);
  return markdownTable(header, rows);
}

function verdict(content: Content, log: RunLog): string {
  const budgets = checkPhaseBudgets(buildBudgetTable(content.pacing), log.phaseDurations);
  const gated = new Set(gatedPhaseIds(content));
  const allWalls = checkWaitWalls(content, log.waitWalls);
  /*
   * A dead zone in a phase that has no mechanics yet is a fact about the
   * roadmap, not a balance regression — there is genuinely nothing to buy in
   * the studio until M5 builds it. Those walls are reported as a *note* so they
   * stay visible, while the verdict is decided by the phases the game actually
   * gates. See `isPlaceholderPhase`.
   */
  const walls = allWalls.filter((wall) => gated.has(wall.phaseId));
  const pending = allWalls.length - walls.length;
  const note =
    pending === 0
      ? ''
      : `\n\n_${pending} further wait wall(s) sit in phases that are still time-gated placeholders; they become real when the milestones that fill those phases land._`;
  if (budgets.length === 0 && walls.length === 0) {
    return `**PASS** — every phase inside its window, no wait wall over budget.${note}`;
  }
  const lines = [
    ...budgets.map(
      (violation) =>
        `- \`${violation.phaseId}\` ${violation.reason} (${violation.actualDesignMinutes.toFixed(1)} vs ${violation.budgetDesignMinutes})`,
    ),
    ...walls.map(
      (wall) =>
        `- \`${wall.phaseId}\` wait wall ${wall.durationDesignMinutes.toFixed(1)} design-min from ${wall.startDesignMinutes.toFixed(1)} (budget ${wall.budgetDesignMinutes})`,
    ),
  ];
  return `**FAIL** — ${lines.length} violation(s):\n\n${lines.join('\n')}${note}`;
}

export function buildReport(input: ReportInput): readonly ReportFile[] {
  const { content, logs, date } = input;
  const table = buildBudgetTable(content.pacing);
  const reference =
    logs.find((log) => log.botId === input.referenceBotId) ?? (logs[0] as RunLog | undefined);
  if (reference === undefined) {
    throw new Error('a balance report needs at least one run');
  }

  const files: ReportFile[] = [
    {
      name: 'phase-timeline.svg',
      contents: barChart('Phase timeline vs budget', timelineRows(table, reference)),
    },
    {
      name: 'wait-walls.svg',
      contents: barChart('Longest wait wall per phase', wallRows(content, reference)),
    },
  ];

  for (const curve of CURVES) {
    files.push({
      name: `curve-${curve.key}.svg`,
      contents: lineChart(curve.title, curve.unit, {
        label: curve.title,
        points: reference.samples.map((sample) => ({
          x: sample.designMinutes,
          y: sample[curve.key],
        })),
      }),
    });
  }

  const markdown = [
    `# Balance report — ${date}`,
    '',
    `Reference bot: \`${reference.botId}\` · target ${content.pacing.targetHours} h ` +
      `· tolerance ±${(table.tolerance * 100).toFixed(0)} %`,
    '',
    verdict(content, reference),
    '',
    '## Phase timeline',
    '',
    '![Phase timeline](./phase-timeline.svg)',
    '',
    summaryTable(table, logs),
    '',
    `The reference run took ${reference.designMinutes.toFixed(1)} design-minutes ` +
      `(${reference.wallHours.toFixed(2)} wall-hours at targetHours=${content.pacing.targetHours}) ` +
      `and ended in \`${reference.finalPhaseId}\`.`,
    '',
    '## Wait walls',
    '',
    'A wait wall is a stretch with no meaningful action available — nothing to',
    'attach, nothing affordable, no idle machine to feed (spec §12.2). Selling',
    'parts does not count: it is a step towards a purchase, not a decision.',
    '',
    '![Wait walls](./wait-walls.svg)',
    '',
    markdownTable(
      ['Phase', 'Longest wall', 'Budget', 'Walls found'],
      content.pacing.phases.map((phase) => {
        const walls = reference.waitWalls.filter((wall) => wall.phaseId === phase.id);
        const worst = longestWallByPhase(reference.waitWalls).get(phase.id) ?? 0;
        return [
          phase.name,
          worst.toFixed(1),
          String(phase.waitWallBudgetDesignMinutes),
          String(walls.length),
        ];
      }),
    ),
    '',
    '## Resource curves',
    '',
    'Small multiples, one scale each — Parts and Money differ by orders of',
    'magnitude and a shared axis would flatten one of them into the floor.',
    '',
    ...CURVES.map((curve) => `![${curve.title}](./curve-${curve.key}.svg)`),
    '',
    '## Activity',
    '',
    markdownTable(
      ['Bot', 'Decisions', 'Actions', 'Prints', 'Failed', 'Failure rate', 'Final phase'],
      logs.map((log) => {
        // Per *print*, not per batch: a batch of twenty prints emits one
        // PRINT_COMPLETED, so counting events would report a 90 % failure rate
        // for a workshop failing one print in six.
        const done = log.finalState.stats.printsCompleted;
        const failed = log.finalState.stats.printsFailed;
        const attempted = done + failed;
        return [
          log.botId,
          String(log.decisions),
          String(log.actions),
          String(done),
          String(failed),
          attempted === 0 ? '—' : `${((failed / attempted) * 100).toFixed(1)} %`,
          log.finalPhaseId,
        ];
      }),
    ),
    '',
    ...(input.sweepCsv === undefined
      ? []
      : ['## Sweep', '', 'Attached as [`sweep.csv`](./sweep.csv).', '']),
    '---',
    '',
    'Generated by `pnpm balance:report`.',
    '',
  ].join('\n');

  files.push({ name: 'report.md', contents: markdown });
  if (input.sweepCsv !== undefined) {
    files.push({ name: 'sweep.csv', contents: input.sweepCsv });
  }
  return files;
}
