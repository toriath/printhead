/**
 * One lane of a parallel sweep (spec §12.3, "parallel across workers").
 *
 * The simulation is synchronous and CPU-bound, so the only way to use more than
 * one core is more than one process. Each worker is handed a slice of the point
 * list as JSON on argv, runs it, and prints the results as JSON on stdout; the
 * parent stitches the slices back together in order. Keeping the protocol to
 * "JSON in, JSON out" means the worker is also runnable by hand when a single
 * point misbehaves.
 */
import { RAW_CONTENT } from '@printhead/core';
import { type SweepPoint, runSweepPoint } from './sweep.js';

interface WorkerJob {
  readonly points: readonly Readonly<Record<string, number>>[];
  readonly botId?: string;
  readonly seed?: number;
  readonly limitDesignMinutes?: number;
}

function main(): void {
  const payload = process.argv[2];
  if (payload === undefined) {
    throw new Error('sweep worker expects a JSON job as its first argument');
  }
  const job = JSON.parse(payload) as WorkerJob;
  const results: SweepPoint[] = job.points.map((overrides) =>
    runSweepPoint(RAW_CONTENT, overrides, {
      ...(job.botId === undefined ? {} : { botId: job.botId }),
      ...(job.seed === undefined ? {} : { seed: job.seed }),
      ...(job.limitDesignMinutes === undefined
        ? {}
        : { limitDesignMinutes: job.limitDesignMinutes }),
    }),
  );
  process.stdout.write(JSON.stringify(results));
}

main();
