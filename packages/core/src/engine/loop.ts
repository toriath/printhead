import { MAX_TICKS_PER_ADVANCE, TICK_MS } from './constants.js';
import type { PaceMapping } from './pace.js';

/**
 * Fixed-timestep accumulator (spec §15). Wall-clock time enters here, is
 * translated to simulation time by the pace mapping (the single place pace is
 * applied, spec §8) and is then consumed in whole `TICK_MS` steps.

 */
export type TickFn<S> = (state: S, simDtMs: number) => S;

export interface AdvanceInput<S> {
  readonly state: S;
  /** Simulation milliseconds left over from the previous call. */
  readonly carrySimMs: number;
  readonly wallDtMs: number;
  readonly pace: PaceMapping;
  readonly tick: TickFn<S>;
  readonly maxTicks?: number;
}

export interface AdvanceResult<S> {
  readonly state: S;
  readonly carrySimMs: number;
  readonly ticks: number;
  /** True when `maxTicks` cut the run short and sim time is still owed. */
  readonly pending: boolean;
}

export function advance<S>(input: AdvanceInput<S>): AdvanceResult<S> {
  const { state, carrySimMs, wallDtMs, pace, tick } = input;
  const maxTicks = input.maxTicks ?? MAX_TICKS_PER_ADVANCE;
  if (!Number.isFinite(wallDtMs) || wallDtMs < 0) {
    throw new RangeError(`wallDtMs must be a non-negative finite number, received ${wallDtMs}`);
  }
  if (!Number.isFinite(carrySimMs) || carrySimMs < 0) {
    throw new RangeError(`carrySimMs must be a non-negative finite number, received ${carrySimMs}`);
  }
  if (!Number.isInteger(maxTicks) || maxTicks <= 0) {
    throw new RangeError(`maxTicks must be a positive integer, received ${maxTicks}`);
  }

  let accumulated = carrySimMs + pace.toSimDtMs(wallDtMs);
  let next = state;
  let ticks = 0;
  while (accumulated >= TICK_MS && ticks < maxTicks) {
    next = tick(next, TICK_MS);
    accumulated -= TICK_MS;
    ticks += 1;
  }
  return { state: next, carrySimMs: accumulated, ticks, pending: accumulated >= TICK_MS };
}
