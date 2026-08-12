import { type RawContent, loadContent, validateContent } from '@printhead/core';
import { REFERENCE_BOT } from './bots.js';
import { designMinutesOf } from './budget.js';
import type { Bot } from './harness.js';
import { runHeadless } from './harness.js';
import { readPointer, writePointer } from './pointer.js';
import { longestWallByPhase } from './waitwall.js';

/**
 * Auto-tuner (spec §12.4). Balance numbers are *fitted by the harness*, never
 * guessed by hand, and what is fitted is always a data field — never a constant
 * in code (spec §19).
 *
 * Two optimisers, because two shapes of problem come up:
 *
 * - {@link tunePhase} bisects a single field against a single phase. Exact and
 *   cheap when one knob obviously owns one phase (printer cost owns bench).
 * - {@link hillClimb} moves several fields at once against the whole timeline.
 *   Phases interact — a cheaper printer shortens bench *and* farm — so once
 *   more than one budget is in play, fitting them one at a time oscillates.
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

// --- multi-field hill climbing (spec §12.4) ---------------------------------

export interface ClimbKnob {
  readonly pointer: string;
  /** Bounds the optimiser may not leave — content stays sane by construction. */
  readonly min: number;
  readonly max: number;
  /** Fields the schema declares as integers (a part count, a level). */
  readonly integer?: boolean;
}

export interface ClimbOptions {
  readonly raw: RawContent;
  readonly knobs: readonly ClimbKnob[];
  /** Phases whose budgets the fit is scored against. */
  readonly phaseIds: readonly string[];
  readonly bot?: Bot;
  readonly seed?: number;
  readonly iterations?: number;
  /** Starting step as a fraction of each knob's current value. */
  readonly stepFraction?: number;
}

export interface ClimbResult {
  readonly values: Readonly<Record<string, number>>;
  readonly score: number;
  readonly phaseDurations: Readonly<Record<string, number>>;
  readonly evaluations: number;
  readonly improved: boolean;
}

/**
 * How hard a wait wall counts against a phase-length miss. Below one, so a
 * timeline that is right with a slightly dead middle still beats one that is
 * lively and forty minutes out.
 */
const WALL_WEIGHT = 0.5;

const DEFAULT_CLIMB_ITERATIONS = 12;
const DEFAULT_STEP_FRACTION = 0.5;
const STEP_SHRINK = 0.6;

/**
 * Squared relative error against every scored phase budget, plus a penalty for
 * every wait wall that overruns its own budget.
 *
 * Relative, so a 5-minute phase and a 90-minute one carry the same weight;
 * squared, so the optimiser fixes the worst phase before polishing the best. A
 * phase the run never reaches scores as if it took the whole run, which keeps
 * the surface monotone rather than flat.
 *
 * The wall term matters because the two goals genuinely trade off: the cheapest
 * way to make a phase shorter is to make everything affordable at once, which
 * empties the middle of the phase. Scoring both together stops the tuner from
 * buying a green timeline with a dead zone.
 */
export function scoreRun(
  raw: RawContent,
  phaseIds: readonly string[],
  options: Omit<TuneOptions, 'raw'> = {},
): { readonly score: number; readonly durations: Record<string, number> } {
  const validation = validateContent(raw);
  if (!validation.ok) {
    // A candidate the schema rejects is simply the worst possible move, not a
    // crash: bounds are a hint, and the schema is the authority on what is a
    // legal content set.
    return { score: Number.POSITIVE_INFINITY, durations: {} };
  }
  const content = validation.content;
  const bot = options.bot ?? REFERENCE_BOT;
  const log = runHeadless({
    content,
    bot,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  const durations: Record<string, number> = {};
  let score = 0;
  for (const phaseId of phaseIds) {
    const phase = content.pacing.phases.find((candidate) => candidate.id === phaseId);
    if (phase === undefined) {
      continue;
    }
    const actual = log.phaseDurations.get(phaseId) ?? log.designMinutes;
    durations[phaseId] = actual;
    const relative = (actual - phase.budgetDesignMinutes) / phase.budgetDesignMinutes;
    score += relative * relative;
  }
  const worst = longestWallByPhase(log.waitWalls);
  for (const phaseId of phaseIds) {
    const phase = content.pacing.phases.find((candidate) => candidate.id === phaseId);
    if (phase === undefined || phase.waitWallBudgetDesignMinutes <= 0) {
      continue;
    }
    const overrun = (worst.get(phaseId) ?? 0) - phase.waitWallBudgetDesignMinutes;
    if (overrun > 0) {
      const relative = overrun / phase.waitWallBudgetDesignMinutes;
      score += WALL_WEIGHT * relative * relative;
    }
  }
  return { score, durations };
}

/**
 * Coordinate-descent hill climb: try each knob up and down by the current step,
 * keep any move that lowers the score, shrink the step when a whole pass finds
 * nothing. Simple on purpose — the search space is a handful of monotone cost
 * curves, and a legible optimiser whose every step is a data diff is worth more
 * here than a clever one.
 */
export function hillClimb(options: ClimbOptions): ClimbResult {
  const { raw, knobs, phaseIds } = options;
  const iterations = options.iterations ?? DEFAULT_CLIMB_ITERATIONS;
  const scoreOptions = {
    ...(options.bot === undefined ? {} : { bot: options.bot }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };

  const values: Record<string, number> = {};
  for (const knob of knobs) {
    const current = readPointer(raw, knob.pointer)[0];
    values[knob.pointer] = current ?? knob.min;
  }
  let best = scoreRun(withOverrides(raw, values), phaseIds, scoreOptions);
  const startScore = best.score;
  let evaluations = 1;
  let step = options.stepFraction ?? DEFAULT_STEP_FRACTION;

  for (let pass = 0; pass < iterations; pass += 1) {
    let anyMove = false;
    for (const knob of knobs) {
      const current = values[knob.pointer] ?? knob.min;
      for (const direction of [1, -1]) {
        const shifted = current * (1 + direction * step);
        const bounded = Math.min(knob.max, Math.max(knob.min, shifted));
        const candidate = knob.integer === true ? Math.round(bounded) : bounded;
        if (candidate === current) {
          continue;
        }
        const trial = { ...values, [knob.pointer]: candidate };
        const scored = scoreRun(withOverrides(raw, trial), phaseIds, scoreOptions);
        evaluations += 1;
        if (scored.score < best.score) {
          values[knob.pointer] = candidate;
          best = scored;
          anyMove = true;
          break;
        }
      }
    }
    if (!anyMove) {
      step *= STEP_SHRINK;
    }
  }

  return {
    values,
    score: best.score,
    phaseDurations: best.durations,
    evaluations,
    improved: best.score < startScore,
  };
}
