import { RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { REFERENCE_BOT } from './bots.js';
import { runHeadless } from './harness.js';
import { readPointer } from './pointer.js';
import { buildReport } from './report.js';
import {
  type SweepPoint,
  axisAroundCurrent,
  gridOf,
  runSweepPoint,
  sampleGrid,
  toCsv,
} from './sweep.js';

const content = loadContent(RAW_CONTENT);
const PRINTER_BASE = 'curves/printer-cost-tier1/base';

describe('gridOf', () => {
  it('is the full cross product, in a stable order', () => {
    const grid = gridOf([
      { pointer: 'a', values: [1, 2] },
      { pointer: 'b', values: [10, 20, 30] },
    ]);
    expect(grid).toHaveLength(6);
    expect(grid[0]).toEqual({ a: 1, b: 10 });
    expect(grid.at(-1)).toEqual({ a: 2, b: 30 });
  });

  it('is a single empty point when there are no axes', () => {
    expect(gridOf([])).toEqual([{}]);
  });
});

describe('sampleGrid', () => {
  const grid = gridOf([{ pointer: 'a', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }]);

  it('returns the whole grid when it is smaller than the sample', () => {
    expect(sampleGrid(grid, 99, 1)).toBe(grid);
  });

  it('takes distinct points', () => {
    const picked = sampleGrid(grid, 4, 3);
    expect(picked).toHaveLength(4);
    expect(new Set(picked.map((point) => point.a)).size).toBe(4);
  });

  /** A sweep whose points move between runs cannot be compared to the last one. */
  it('is deterministic in the seed', () => {
    expect(sampleGrid(grid, 5, 7)).toEqual(sampleGrid(grid, 5, 7));
    expect(sampleGrid(grid, 5, 7)).not.toEqual(sampleGrid(grid, 5, 8));
  });
});

describe('axisAroundCurrent', () => {
  it('brackets whatever the content currently holds', () => {
    const current = readPointer(RAW_CONTENT, PRINTER_BASE)[0] ?? 0;
    const axis = axisAroundCurrent(RAW_CONTENT, PRINTER_BASE, 2, 5);
    expect(axis.values).toHaveLength(5);
    expect(axis.values[0]).toBeCloseTo(current / 2, 9);
    expect(axis.values.at(-1)).toBeCloseTo(current * 2, 9);
    expect(axis.values[2]).toBeCloseTo((current / 2 + current * 2) / 2, 9);
  });

  it('degenerates to the current value for a single step', () => {
    const current = readPointer(RAW_CONTENT, PRINTER_BASE)[0] ?? 0;
    expect(axisAroundCurrent(RAW_CONTENT, PRINTER_BASE, 2, 1).values).toEqual([current]);
  });

  it('refuses a pointer that resolves to nothing', () => {
    expect(() => axisAroundCurrent(RAW_CONTENT, 'curves/ghost/base', 2, 3)).toThrow();
  });
});

describe('runSweepPoint', () => {
  it('runs the real core with the override applied and scores it', () => {
    const point = runSweepPoint(RAW_CONTENT, { [PRINTER_BASE]: 40 }, { limitDesignMinutes: 60 });
    expect(point.overrides[PRINTER_BASE]).toBe(40);
    expect(point.totalDesignMinutes).toBeGreaterThan(0);
    expect(point.phaseDurations.intro).toBeGreaterThan(0);
    expect(point.finalPhaseId.length).toBeGreaterThan(0);
  });

  it('a dearer printer makes the bench phase longer', () => {
    const cheap = runSweepPoint(RAW_CONTENT, { [PRINTER_BASE]: 6 }, { limitDesignMinutes: 200 });
    const dear = runSweepPoint(RAW_CONTENT, { [PRINTER_BASE]: 120 }, { limitDesignMinutes: 200 });
    expect(dear.phaseDurations.bench ?? Number.POSITIVE_INFINITY).toBeGreaterThan(
      cheap.phaseDurations.bench ?? 0,
    );
  });
});

describe('toCsv', () => {
  const points: readonly SweepPoint[] = [
    {
      overrides: { 'curves/x/base': 1 },
      totalDesignMinutes: 420,
      phaseDurations: { intro: 5, bench: 30 },
      longestWaitWallDesignMinutes: 2.5,
      budgetViolations: 0,
      waitWallViolations: 0,
      finalPhaseId: 'end',
    },
    {
      overrides: { 'curves/x/base': 2 },
      totalDesignMinutes: 420,
      phaseDurations: { intro: 5 },
      longestWaitWallDesignMinutes: 9,
      budgetViolations: 3,
      waitWallViolations: 1,
      finalPhaseId: 'bench',
    },
  ];

  it('writes one column per swept field and per phase', () => {
    const csv = toCsv(points, ['intro', 'bench']);
    const [header, first, second] = csv.split('\n');
    expect(header).toBe(
      'curves/x/base,phase:intro,phase:bench,total,longestWaitWall,budgetViolations,waitWallViolations,finalPhase',
    );
    expect(first).toBe('1,5.00,30.00,420.00,2.50,0,0,end');
    // A phase the run never reached is blank, not zero — they mean different things.
    expect(second).toBe('2,5.00,,420.00,9.00,3,1,bench');
  });

  it('quotes a cell containing the separator', () => {
    const csv = toCsv([{ ...(points[0] as SweepPoint), finalPhaseId: 'a,b' }], ['intro']);
    expect(csv).toContain('"a,b"');
  });
});

describe('buildReport', () => {
  const logs = [runHeadless({ content, bot: REFERENCE_BOT, limitDesignMinutes: 40 })];
  const files = buildReport({
    content,
    logs,
    referenceBotId: REFERENCE_BOT.id,
    date: '2026-08-12',
  });
  const named = (name: string) => files.find((file) => file.name === name);

  it('writes a markdown report plus one SVG per chart', () => {
    expect(named('report.md')).toBeDefined();
    expect(named('phase-timeline.svg')).toBeDefined();
    expect(named('wait-walls.svg')).toBeDefined();
    expect(named('curve-parts.svg')).toBeDefined();
    expect(named('curve-money.svg')).toBeDefined();
  });

  it('leads with a verdict a reviewer can act on', () => {
    const markdown = named('report.md')?.contents ?? '';
    expect(markdown).toContain('# Balance report — 2026-08-12');
    expect(markdown).toMatch(/\*\*(PASS|FAIL)\*\*/);
    expect(markdown).toContain('| Phase | Budget |');
  });

  it('draws each resource on its own scale — never two y-axes on one plot', () => {
    const svg = named('curve-money.svg')?.contents ?? '';
    expect(svg).toContain('<svg');
    // One series, one path, and the title names it, so no legend is needed.
    expect(svg.match(/class="line"/g)).toHaveLength(1);
    expect(svg).toContain('Money');
  });

  it('labels every bar with its number and verdict, not colour alone', () => {
    const svg = named('phase-timeline.svg')?.contents ?? '';
    expect(svg).toMatch(/OK|OVER|not reached/);
  });

  it('renders in both light and dark surfaces', () => {
    const svg = named('wait-walls.svg')?.contents ?? '';
    expect(svg).toContain('prefers-color-scheme: dark');
  });

  it('attaches a sweep when one is handed to it', () => {
    const withSweep = buildReport({
      content,
      logs,
      referenceBotId: REFERENCE_BOT.id,
      date: '2026-08-12',
      sweepCsv: 'a,b\n1,2\n',
    });
    expect(withSweep.find((file) => file.name === 'sweep.csv')?.contents).toBe('a,b\n1,2\n');
    expect(withSweep.find((file) => file.name === 'report.md')?.contents).toContain('sweep.csv');
  });

  it('refuses to report on nothing', () => {
    expect(() =>
      buildReport({ content, logs: [], referenceBotId: 'balanced', date: '2026-08-12' }),
    ).toThrow(/at least one run/);
  });
});
