import type { CurveDef } from './schema.js';

export class UnknownCurveError extends Error {
  constructor(public readonly curveId: string) {
    super(`unknown curve id: ${curveId}`);
    this.name = 'UnknownCurveError';
  }
}

/**
 * Evaluate a parametric curve at step `n` (0-based: `n = 0` is the first
 * purchase / level / unit).
 *
 * - constant:    value
 * - linear:      base + step * n
 * - exponential: base * growth^n
 * - power:       base * (n + 1)^exponent
 */
export function evaluateCurve(curve: CurveDef, n: number): number {
  if (!Number.isFinite(n)) {
    throw new RangeError(`curve step must be finite, received ${n}`);
  }
  switch (curve.type) {
    case 'constant':
      return curve.value;
    case 'linear':
      return curve.base + curve.step * n;
    case 'exponential':
      return curve.base * curve.growth ** n;
    case 'power':
      return curve.base * (n + 1) ** curve.exponent;
  }
}

export type CurveRegistry = ReadonlyMap<string, CurveDef>;

export function createCurveRegistry(curves: readonly CurveDef[]): CurveRegistry {
  return new Map(curves.map((curve) => [curve.id, curve]));
}

export function getCurve(registry: CurveRegistry, curveId: string): CurveDef {
  const curve = registry.get(curveId);
  if (curve === undefined) {
    throw new UnknownCurveError(curveId);
  }
  return curve;
}

export function evaluateCurveById(registry: CurveRegistry, curveId: string, n: number): number {
  return evaluateCurve(getCurve(registry, curveId), n);
}

/** Sum of a curve over `[from, from + count)` — e.g. the price of a bulk buy. */
export function sumCurve(curve: CurveDef, from: number, count: number): number {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`curve sum count must be a non-negative integer, received ${count}`);
  }
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    total += evaluateCurve(curve, from + i);
  }
  return total;
}
