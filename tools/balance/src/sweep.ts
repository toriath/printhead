import { type RawContent, loadContent } from '@printhead/core';
import { REFERENCE_BOT, findBot } from './bots.js';
import { buildBudgetTable, checkPhaseBudgets } from './budget.js';
import { type RunLog, runHeadless } from './harness.js';
import { readPointer } from './pointer.js';
import { withOverrides } from './tune.js';
import { checkWaitWalls, longestWallByPhase } from './waitwall.js';

/**
 * Sweep runner (spec §12.3): grid or random search over selected content fields
 * addressed by pointer, emitting CSV.
 *
 * A sweep is how a balance question gets answered with evidence instead of a
 * hunch: "how does bench length respond to the printer cost curve?" is one
 * axis, one run per point, one column per phase. The output is deliberately
 * CSV — it goes into a spreadsheet, a notebook or the report generator, and it
 * survives being pasted into a pull request.
 */
export interface SweepAxis {
  /** Content field to vary, e.g. `curves/printer-cost-tier1/base`. */
  readonly pointer: string;
  readonly values: readonly number[];
}

export interface SweepOptions {
  readonly raw: RawContent;
  readonly axes: readonly SweepAxis[];
  readonly botId?: string;
  readonly seed?: number;
  /** Random sampling instead of the full grid — `undefined` sweeps everything. */
  readonly samples?: number;
  readonly limitDesignMinutes?: number;
}

export interface SweepPoint {
  /** Pointer → value for this point. */
  readonly overrides: Readonly<Record<string, number>>;
  readonly totalDesignMinutes: number;
  /** phaseId → design minutes spent in it (missing = never reached). */
  readonly phaseDurations: Readonly<Record<string, number>>;
  readonly longestWaitWallDesignMinutes: number;
  readonly budgetViolations: number;
  readonly waitWallViolations: number;
  readonly finalPhaseId: string;
}

/** Every combination of the axes, in a stable order. */
export function gridOf(axes: readonly SweepAxis[]): readonly Readonly<Record<string, number>>[] {
  let points: Record<string, number>[] = [{}];
  for (const axis of axes) {
    const next: Record<string, number>[] = [];
    for (const point of points) {
      for (const value of axis.values) {
        next.push({ ...point, [axis.pointer]: value });
      }
    }
    points = next;
  }
  return points;
}

/**
 * A deterministic sub-sample of the grid. Random search beats grid search once
 * there are more than two axes, and "deterministic" is not optional here: a
 * sweep whose points move between runs cannot be compared to the last one.
 */
export function sampleGrid(
  grid: readonly Readonly<Record<string, number>>[],
  samples: number,
  seed: number,
): readonly Readonly<Record<string, number>>[] {
  if (samples >= grid.length) {
    return grid;
  }
  const picked: Readonly<Record<string, number>>[] = [];
  const taken = new Set<number>();
  let cursor = Math.abs(seed) % Math.max(grid.length, 1);
  // A coprime stride visits every index exactly once before repeating.
  const stride = 1 + (Math.abs(seed) % Math.max(grid.length - 1, 1));
  while (picked.length < samples && taken.size < grid.length) {
    if (!taken.has(cursor)) {
      taken.add(cursor);
      const point = grid[cursor];
      if (point !== undefined) {
        picked.push(point);
      }
    }
    cursor = (cursor + stride) % grid.length;
  }
  return picked;
}

export function runSweepPoint(
  raw: RawContent,
  overrides: Readonly<Record<string, number>>,
  options: Omit<SweepOptions, 'raw' | 'axes'> = {},
): SweepPoint {
  const content = loadContent(withOverrides(raw, overrides));
  const bot = options.botId === undefined ? REFERENCE_BOT : findBot(options.botId);
  const log: RunLog = runHeadless({
    content,
    bot,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.limitDesignMinutes === undefined
      ? {}
      : { limitDesignMinutes: options.limitDesignMinutes }),
  });
  const walls = checkWaitWalls(content, log.waitWalls);
  const longest = [...longestWallByPhase(log.waitWalls).values()];
  return {
    overrides,
    totalDesignMinutes: log.designMinutes,
    phaseDurations: Object.fromEntries(log.phaseDurations),
    longestWaitWallDesignMinutes: longest.length === 0 ? 0 : Math.max(...longest),
    budgetViolations: checkPhaseBudgets(buildBudgetTable(content.pacing), log.phaseDurations)
      .length,
    waitWallViolations: walls.length,
    finalPhaseId: log.finalPhaseId,
  };
}

export function runSweep(options: SweepOptions): readonly SweepPoint[] {
  const grid = gridOf(options.axes);
  const points =
    options.samples === undefined ? grid : sampleGrid(grid, options.samples, options.seed ?? 1);
  return points.map((overrides) =>
    runSweepPoint(options.raw, overrides, {
      ...(options.botId === undefined ? {} : { botId: options.botId }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.limitDesignMinutes === undefined
        ? {}
        : { limitDesignMinutes: options.limitDesignMinutes }),
    }),
  );
}

const CSV_SEPARATOR = ',';

function csvCell(value: string | number): string {
  const text = String(value);
  return text.includes(CSV_SEPARATOR) || text.includes('"')
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

/** One row per point, one column per swept field and per phase. */
export function toCsv(points: readonly SweepPoint[], phaseIds: readonly string[]): string {
  const pointers = [...new Set(points.flatMap((point) => Object.keys(point.overrides)))].sort();
  const header = [
    ...pointers,
    ...phaseIds.map((id) => `phase:${id}`),
    'total',
    'longestWaitWall',
    'budgetViolations',
    'waitWallViolations',
    'finalPhase',
  ];
  const rows = points.map((point) =>
    [
      ...pointers.map((pointer) => point.overrides[pointer] ?? ''),
      ...phaseIds.map((id) => {
        const duration = point.phaseDurations[id];
        return duration === undefined ? '' : duration.toFixed(2);
      }),
      point.totalDesignMinutes.toFixed(2),
      point.longestWaitWallDesignMinutes.toFixed(2),
      point.budgetViolations,
      point.waitWallViolations,
      point.finalPhaseId,
    ]
      .map(csvCell)
      .join(CSV_SEPARATOR),
  );
  return [header.map(csvCell).join(CSV_SEPARATOR), ...rows].join('\n');
}

/**
 * Build an axis of `steps` values around whatever the content currently holds.
 * Sweeping "×0.5 to ×2 of today's number" is almost always what is wanted, and
 * reading the centre out of the content means the axis follows the balance
 * instead of going stale next to it.
 */
export function axisAroundCurrent(
  raw: RawContent,
  pointer: string,
  spread: number,
  steps: number,
): SweepAxis {
  const current = readPointer(raw, pointer)[0];
  if (current === undefined) {
    throw new Error(`sweep axis ${pointer} resolves to nothing`);
  }
  if (steps < 2) {
    return { pointer, values: [current] };
  }
  const lo = current / spread;
  const hi = current * spread;
  const values = Array.from(
    { length: steps },
    (_unused, index) => lo + ((hi - lo) * index) / (steps - 1),
  );
  return { pointer, values };
}
