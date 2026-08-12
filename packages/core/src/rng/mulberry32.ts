/**
 * Deterministic PRNG (spec §13). `core` must never touch `Math.random`:
 * every stochastic decision comes from a seeded, forkable mulberry32 stream so
 * that any bug is reproducible from `(seed, actionLog)`.
 */
export interface Rng {
  readonly seed: number;
  /** Number of draws taken so far — part of the save state. */
  readonly count: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Independent child stream, deterministic in (seed, label, count). */
  fork(label: string): Rng;
  /** Serializable position of this stream. */
  snapshot(): RngSnapshot;
}

export interface RngSnapshot {
  readonly seed: number;
  readonly count: number;
}

const UINT32 = 0x100000000;
const MULBERRY_INCREMENT = 0x6d2b79f5;

/**
 * A uniform draw in `[0, 1)` derived purely from a label and the seed, taking
 * *no* position from any stream. Models that must be a pure function of
 * `(seed, time)` — the market's noise term, per-material phase offsets — use
 * this rather than an `Rng`, so replaying a save from any point reproduces the
 * same curve without having to replay every draw that led to it.
 */
export function hashUnit(label: string, seed: number): number {
  return hashSeed(label, seed) / UINT32;
}

export function hashSeed(label: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i += 1) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function draw(state: number): { value: number; state: number } {
  const nextState = (state + MULBERRY_INCREMENT) >>> 0;
  let t = nextState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / UINT32, state: nextState };
}

export function createRng(seed: number, count = 0): Rng {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`rng seed must be an integer, received ${seed}`);
  }
  let state = seed >>> 0;
  let drawn = 0;
  for (let i = 0; i < count; i += 1) {
    state = draw(state).state;
    drawn += 1;
  }
  const rng: Rng = {
    seed: seed >>> 0,
    get count() {
      return drawn;
    },
    next() {
      const result = draw(state);
      state = result.state;
      drawn += 1;
      return result.value;
    },
    nextInt(maxExclusive: number) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`nextInt bound must be a positive integer, received ${maxExclusive}`);
      }
      return Math.floor(rng.next() * maxExclusive);
    },
    fork(label: string) {
      return createRng(hashSeed(`${label}:${drawn}`, seed));
    },
    snapshot() {
      return { seed: seed >>> 0, count: drawn };
    },
  };
  return rng;
}

export function restoreRng(snapshot: RngSnapshot): Rng {
  return createRng(snapshot.seed, snapshot.count);
}
