import { type RawContent, loadContent } from '@printhead/core';
import { REFERENCE_BOT } from './bots.js';
import { designMinutesOf } from './budget.js';
import type { Bot } from './harness.js';
import { runHeadless } from './harness.js';
import { writePointer } from './pointer.js';

/**
 * Auto-tuner (spec §12.4), first instalment: bisection on one content field
 * until a phase lands on its §6 budget. Deliberately small — it exists so that
 * balance numbers are *fitted by the harness* rather than guessed by hand, and
 * so the thing that is fitted is a data field, never a constant in code.
 *
 * The full grid/random sweep and the report generator are M3.
 */
export interface TuneTarget {
  /** Content field to move, e.g. `curves/printer-cost-tier1/base`. */
  readonly pointer: string;
  /** Phase whose duration should hit its budget. */
  readonly phaseId: string;
  readonly lo: number;
  readonly hi: number;
  readonly iterations?: number;
}

export interface TuneOptions {
  readonly raw: RawContent;
  readonly bot?: Bot;
  readonly seed?: number;
}

export interface TuneStep {
  readonly value: number;
  readonly actualDesignMinutes: number;
}

export interface TuneResult {
  readonly pointer: string;
  readonly phaseId: string;
  readonly value: number;
  readonly actualDesignMinutes: number;
  readonly budgetDesignMinutes: number;
  readonly steps: readonly TuneStep[];
}

const DEFAULT_ITERATIONS = 18;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Apply candidate values to a fresh copy of the raw content. */
export function withOverrides(
  raw: RawContent,
  overrides: Readonly<Record<string, number>>,
): RawContent {
  const candidate = clone(raw);
  for (const [pointer, value] of Object.entries(overrides)) {
    writePointer(candidate, pointer, value);
  }
  return candidate;
}

/**
 * How long the bot spends in `phaseId` with these overrides applied. Phases the
 * run never reaches score as the whole run, which makes "never got there" read
 * as "far too slow" and keeps the search monotone.
 */
export function measurePhase(
  raw: RawContent,
  phaseId: string,
  options: Omit<TuneOptions, 'raw'> = {},
): number {
  const content = loadContent(raw);
  const bot = options.bot ?? REFERENCE_BOT;
  const log = runHeadless({
    content,
    bot,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const actual = log.phaseDurations.get(phaseId);
  return actual ?? designMinutesOf(Number.POSITIVE_INFINITY);
}

/**
 * Bisect `pointer` until `phaseId` hits its budget. Assumes the phase duration
 * is monotonically non-decreasing in the field — true for costs and durations,
 * which is what this is pointed at.
 */
export function tunePhase(target: TuneTarget, options: TuneOptions): TuneResult {
  const { raw } = options;
  const budget =
    loadContent(raw).pacing.phases.find((phase) => phase.id === target.phaseId)
      ?.budgetDesignMinutes ?? 0;
  const iterations = target.iterations ?? DEFAULT_ITERATIONS;
  const steps: TuneStep[] = [];

  let lo = target.lo;
  let hi = target.hi;
  let best = { value: lo, actual: Number.POSITIVE_INFINITY };

  for (let i = 0; i < iterations; i += 1) {
    const value = (lo + hi) / 2;
    const actual = measurePhase(withOverrides(raw, { [target.pointer]: value }), target.phaseId, {
      ...(options.bot === undefined ? {} : { bot: options.bot }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    steps.push({ value, actualDesignMinutes: actual });
    if (Math.abs(actual - budget) < Math.abs(best.actual - budget)) {
      best = { value, actual };
    }
    if (actual < budget) {
      lo = value;
    } else {
      hi = value;
    }
  }

  return {
    pointer: target.pointer,
    phaseId: target.phaseId,
    value: best.value,
    actualDesignMinutes: best.actual,
    budgetDesignMinutes: budget,
    steps,
  };
}
