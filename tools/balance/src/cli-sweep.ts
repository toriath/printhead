/**
 * `pnpm balance:sweep` — grid or random search over content fields, CSV out
 * (spec §12.3).
 *
 *   pnpm balance:sweep curves/printer-cost-tier1/base curves/upgrade-cost-machine/base
 *   pnpm balance:sweep <pointer...> --steps 5 --spread 2 --samples 12 --bot balanced
 *
 * Each pointer becomes an axis of `--steps` values spanning ×1/spread … ×spread
 * around whatever the content currently holds, so a sweep always brackets the
 * shipped balance instead of drifting away from it.
 */
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RAW_CONTENT, loadContent } from '@printhead/core';
import { type SweepPoint, axisAroundCurrent, gridOf, sampleGrid, toCsv } from './sweep.js';

const execFileAsync = promisify(execFile);

/** Leave a core for the parent and the OS, and cap at three workers. */
const MAX_WORKERS = Math.max(1, Math.min(3, cpus().length - 1));
const WORKER = fileURLToPath(new URL('./sweep-worker.ts', import.meta.url));

interface Args {
  readonly pointers: readonly string[];
  readonly steps: number;
  readonly spread: number;
  readonly samples: number | undefined;
  readonly botId: string | undefined;
  readonly seed: number;
  readonly workers: number;
}

function parseArgs(argv: readonly string[]): Args {
  const pointers: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (token.startsWith('--')) {
      flags.set(token.slice(2), argv[i + 1] ?? '');
      i += 1;
      continue;
    }
    pointers.push(token);
  }
  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    pointers,
    steps: number('steps', 5),
    spread: number('spread', 2),
    samples: flags.has('samples') ? number('samples', 0) : undefined,
    botId: flags.get('bot'),
    seed: number('seed', 1),
    workers: number('workers', MAX_WORKERS),
  };
}

function chunk<T>(items: readonly T[], lanes: number): readonly (readonly T[])[] {
  const size = Math.ceil(items.length / lanes);
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.pointers.length === 0) {
    console.error('usage: pnpm balance:sweep <content-pointer...> [--steps n] [--spread x]');
    console.error('example: pnpm balance:sweep curves/printer-cost-tier1/base --steps 7');
    process.exit(2);
  }

  const axes = args.pointers.map((pointer) =>
    axisAroundCurrent(RAW_CONTENT, pointer, args.spread, args.steps),
  );
  const grid = gridOf(axes);
  const points = args.samples === undefined ? grid : sampleGrid(grid, args.samples, args.seed);

  console.error(
    `sweeping ${points.length} point(s) over ${axes.length} axis/axes ` +
      `across ${Math.min(args.workers, points.length)} worker(s)`,
  );

  const lanes = chunk(points, Math.max(1, Math.min(args.workers, points.length)));
  const results = await Promise.all(
    lanes.map(async (lane) => {
      const job = JSON.stringify({
        points: lane,
        ...(args.botId === undefined ? {} : { botId: args.botId }),
        seed: args.seed,
      });
      const { stdout } = await execFileAsync('node', ['--import', 'tsx', WORKER, job], {
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(stdout) as SweepPoint[];
    }),
  );

  const flat = results.flat();
  const phaseIds = loadContent(RAW_CONTENT).pacing.phases.map((phase) => phase.id);
  process.stdout.write(`${toCsv(flat, phaseIds)}\n`);

  const clean = flat.filter(
    (point) => point.budgetViolations === 0 && point.waitWallViolations === 0,
  );
  console.error(`${clean.length}/${flat.length} point(s) passed every budget`);
}

void main();
