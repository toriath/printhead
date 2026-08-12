import { MAX_TICKS_PER_ADVANCE, MS_PER_HOUR, MS_PER_MINUTE, TICK_MS } from './constants.js';
import type { PaceMapping } from './pace.js';

/**
 * Fixed-timestep accumulator (spec §15). Wall-clock time enters here, is
 * translated to simulation time by the pace mapping (the single place pace is
 * applied, spec §8) and is then consumed in whole `TICK_MS` steps.
 *
 * Offline catch-up is the very same code path, just chunked and capped.
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

export interface OfflineInput<S> {
  readonly state: S;
  readonly carrySimMs: number;
  readonly wallElapsedMs: number;
  readonly pace: PaceMapping;
  readonly tick: TickFn<S>;
  /** From `content/pacing.json` — offline progress is capped (spec §7.4). */
  readonly capHours: number;
  readonly chunkWallMs?: number;
  readonly maxTicks?: number;
}

export interface OfflineResult<S> {
  readonly state: S;
  readonly carrySimMs: number;
  readonly ticks: number;
  readonly appliedWallMs: number;
  readonly skippedWallMs: number;
  readonly chunks: number;
}

export const DEFAULT_OFFLINE_CHUNK_WALL_MS = MS_PER_MINUTE * 10;

/** Deterministic chunked fast-forward through the normal tick path. */
export function advanceOffline<S>(input: OfflineInput<S>): OfflineResult<S> {
  const { pace, tick, capHours } = input;
  if (!Number.isFinite(input.wallElapsedMs) || input.wallElapsedMs < 0) {
    throw new RangeError(`wallElapsedMs must be non-negative, received ${input.wallElapsedMs}`);
  }
  if (!Number.isFinite(capHours) || capHours <= 0) {
    throw new RangeError(`capHours must be positive, received ${capHours}`);
  }
  const chunkWallMs = input.chunkWallMs ?? DEFAULT_OFFLINE_CHUNK_WALL_MS;
  if (!Number.isFinite(chunkWallMs) || chunkWallMs <= 0) {
    throw new RangeError(`chunkWallMs must be positive, received ${chunkWallMs}`);
  }

  const capMs = capHours * MS_PER_HOUR;
  const appliedWallMs = Math.min(input.wallElapsedMs, capMs);
  const skippedWallMs = input.wallElapsedMs - appliedWallMs;

  let state = input.state;
  let carrySimMs = input.carrySimMs;
  let ticks = 0;
  let chunks = 0;
  let remaining = appliedWallMs;

  while (remaining > 0) {
    const chunk = Math.min(chunkWallMs, remaining);
    let step = advance({
      state,
      carrySimMs,
      wallDtMs: chunk,
      pace,
      tick,
      ...(input.maxTicks === undefined ? {} : { maxTicks: input.maxTicks }),
    });
    state = step.state;
    carrySimMs = step.carrySimMs;
    ticks += step.ticks;
    while (step.pending) {
      step = advance({
        state,
        carrySimMs,
        wallDtMs: 0,
        pace,
        tick,
        ...(input.maxTicks === undefined ? {} : { maxTicks: input.maxTicks }),
      });
      state = step.state;
      carrySimMs = step.carrySimMs;
      ticks += step.ticks;
    }
    remaining -= chunk;
    chunks += 1;
  }

  return { state, carrySimMs, ticks, appliedWallMs, skippedWallMs, chunks };
}
