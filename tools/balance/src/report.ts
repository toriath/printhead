import type { Content } from '@printhead/core';
import { type BudgetTable, buildBudgetTable, checkPhaseBudgets, gatedPhaseIds } from './budget.js';
import {
  buildOrder,
  choreShare,
  deadContent,
  longestDroughtByPhase,
  orderDivergence,
  topChore,
} from './fun.js';
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
  /** Runs by human-ish bots (`human.ts`): the crowd, not the rulers. */
  readonly crowd?: readonly RunLog[];
}

/**
 * The crowd: how long the arc took each human-ish player, whether they
 * finished, and the phase that dragged most against its budget — where a real
 * player is most likely to stall.
 */
/** Phases shorter than this are left out of the crowd's stall column. */
const CROWD_MIN_PHASE_MINUTES = 5;

function crowdLines(table: BudgetTable, crowd: readonly RunLog[]): readonly string[] {
  if (crowd.length === 0) {
    return [];
  }
  const rows = crowd.map((log) => {
    const arc = log.phaseEnteredAt.get(table.terminalPhaseId ?? '');
    let worst = { phaseId: '—', ratio: 0 };
    for (const phase of table.phases) {
      const actual = log.phaseDurations.get(phase.phaseId);
      // A minute-long intro is all reaction time; it says nothing about stalls.
      if (
        actual === undefined ||
        phase.phaseId === table.terminalPhaseId ||
        phase.budgetDesignMinutes < CROWD_MIN_PHASE_MINUTES
      ) {
        continue;
      }
      const ratio = actual / phase.budgetDesignMinutes;
      if (ratio > worst.ratio) {
        worst = { phaseId: phase.phaseId, ratio };
      }
    }
    return [
      log.botId,
      arc === undefined ? 'did not finish' : `${arc.toFixed(0)} min`,
      arc === undefined ? '—' : `${((arc / table.totalDesignMinutes - 1) * 100).toFixed(0)} %`,
      `${worst.phaseId} (×${worst.ratio.toFixed(2)})`,
    ];
  });
  return [
    '## Human crowd',
    '',
    'Policy bots with a person wrapped round them (`tools/balance/src/human.ts`): a',
    'seeded personality, wandering attention and a few forgotten moves. Where they',
    'drag is where a real player is likely to stall.',
    '',
    markdownTable(['Human', 'Arc', 'vs budget', 'Slowest phase vs its budget'], rows),
    '',
  ];
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
    // The terminal sandbox has no window: nothing ends it, so how long a player
    // stays there is a choice rather than a budget (see `terminalPhaseId`).
    phase.phaseId === table.terminalPhaseId
      ? 'sandbox'
      : `${phase.budgetDesignMinutes} (${phase.minDesignMinutes.toFixed(0)}–${phase.maxDesignMinutes.toFixed(0)})`,
    ...logs.map((log) => {
      const actual = log.phaseDurations.get(phase.phaseId);
      return actual === undefined ? '—' : actual.toFixed(1);
    }),
  ]);
  rows.push([
    '**Total (the arc)**',
    `**${table.totalDesignMinutes}**`,
    // The arc is over when the sandbox is reached; the run goes on a little
    // longer so the post-game can be observed, and that tail is not the arc.
    ...logs.map((log) => {
      const arc =
        table.terminalPhaseId === undefined
          ? undefined
          : log.phaseEnteredAt.get(table.terminalPhaseId);
      return `**${(arc ?? log.designMinutes).toFixed(1)}**`;
    }),
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

/** How differently each strategy ordered its purchases from the reference. */
function divergenceLines(logs: readonly RunLog[]): readonly string[] {
  const active = logs.filter((log) => log.actions > 0);
  const [first, ...rest] = active;
  if (first === undefined || rest.length === 0) {
    return [];
  }
  return rest.map(
    (log) =>
      `Build-order divergence, \`${first.botId}\` vs \`${log.botId}\`: ` +
      `${orderDivergence(buildOrder(first), buildOrder(log)).toFixed(2)} (0 = the same order, ~0.5 = unrelated).`,
  );
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
      `· tolerance ±${(table.arcTolerance * 100).toFixed(0)} % for the arc, ` +
      `±${(table.tolerance * 100).toFixed(0)} % per phase`,
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
    '## Fun signals',
    '',
    'The budgets above say whether the game is the right length. These say',
    'whether the minutes are any good (see `tools/balance/src/fun.ts`). A',
    '*drought* is the longest stretch in a phase with nothing new: no new',
    'upgrade, machine, material, design, branch or phase. *Chores* are upkeep',
    'actions (sell, recycle, restock, reload) as a share of all actions. Bots',
    'are not players: read these as where to look, not as verdicts.',
    '',
    markdownTable(
      ['Bot', 'Chores', 'Most repeated', ...content.pacing.phases.slice(0, -1).map((p) => p.name)],
      logs
        .filter((log) => log.actions > 0)
        .map((log) => {
          const droughts = longestDroughtByPhase(log);
          const chore = topChore(log);
          return [
            log.botId,
            `${(choreShare(log) * 100).toFixed(0)} %`,
            chore === null ? '—' : `${chore.type} ×${chore.count}`,
            ...content.pacing.phases.slice(0, -1).map((phase) => {
              const drought = droughts.get(phase.id);
              return drought === undefined ? '—' : drought.toFixed(0);
            }),
          ];
        }),
    ),
    '',
    `Never bought by any bot: ${
      deadContent(logs, content)
        .map((id) => `\`${id}\``)
        .join(', ') || 'nothing'
    }.`,
    '',
    ...divergenceLines(logs),
    '',
    ...crowdLines(table, input.crowd ?? []),
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
