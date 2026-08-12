import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  UnknownCurveError,
  createCurveRegistry,
  evaluateCurve,
  evaluateCurveById,
  getCurve,
  sumCurve,
} from './evaluate.js';
import { type CurveDef, CurveDefSchema, ID_PATTERN, IdSchema } from './schema.js';

const constant: CurveDef = { id: 'c', name: 'c', type: 'constant', value: 7 };
const linear: CurveDef = { id: 'l', name: 'l', type: 'linear', base: 10, step: 2.5 };
const exponential: CurveDef = { id: 'e', name: 'e', type: 'exponential', base: 12, growth: 1.5 };
const power: CurveDef = { id: 'p', name: 'p', type: 'power', base: 2, exponent: 2 };

describe('evaluateCurve', () => {
  it('returns the value of a constant curve at every step', () => {
    expect(evaluateCurve(constant, 0)).toBe(7);
    expect(evaluateCurve(constant, 5)).toBe(7);
  });

  it('evaluates linear curves as base + step * n', () => {
    expect(evaluateCurve(linear, 0)).toBe(10);
    expect(evaluateCurve(linear, 1)).toBe(12.5);
    expect(evaluateCurve(linear, 4)).toBe(20);
  });

  it('evaluates exponential curves as base * growth^n', () => {
    expect(evaluateCurve(exponential, 0)).toBe(12);
    expect(evaluateCurve(exponential, 1)).toBe(18);
    expect(evaluateCurve(exponential, 2)).toBe(27);
  });

  it('evaluates power curves as base * (n + 1)^exponent', () => {
    expect(evaluateCurve(power, 0)).toBe(2);
    expect(evaluateCurve(power, 1)).toBe(8);
    expect(evaluateCurve(power, 3)).toBe(32);
  });

  it('rejects non-finite steps', () => {
    expect(() => evaluateCurve(linear, Number.NaN)).toThrow(
      'curve step must be finite, received NaN',
    );
    expect(() => evaluateCurve(linear, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('is monotonically increasing for growth > 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (n) => {
        expect(evaluateCurve(exponential, n + 1)).toBeGreaterThan(evaluateCurve(exponential, n));
      }),
    );
  });
});

describe('sumCurve', () => {
  it('sums consecutive evaluations', () => {
    expect(sumCurve(linear, 0, 3)).toBe(10 + 12.5 + 15);
  });

  it('is zero for an empty range', () => {
    expect(sumCurve(exponential, 3, 0)).toBe(0);
  });

  it('splits additively', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (from, a, b) => {
          expect(sumCurve(exponential, from, a + b)).toBeCloseTo(
            sumCurve(exponential, from, a) + sumCurve(exponential, from + a, b),
            8,
          );
        },
      ),
    );
  });

  it('rejects negative or fractional counts', () => {
    expect(() => sumCurve(linear, 0, -1)).toThrow(
      'curve sum count must be a non-negative integer, received -1',
    );
    expect(() => sumCurve(linear, 0, 1.5)).toThrow(RangeError);
  });
});

describe('curve registry', () => {
  const registry = createCurveRegistry([constant, linear]);

  it('resolves curves by id', () => {
    expect(getCurve(registry, 'l')).toEqual(linear);
    expect(evaluateCurveById(registry, 'c', 3)).toBe(7);
  });

  it('throws a typed error for unknown ids', () => {
    expect(() => getCurve(registry, 'nope')).toThrow(UnknownCurveError);
    expect(() => getCurve(registry, 'nope')).toThrow('unknown curve id: nope');
    expect(() => evaluateCurveById(registry, 'nope', 0)).toThrowError(/nope/);
  });
});

describe('CurveDefSchema', () => {
  it('rejects unknown curve types and stray fields', () => {
    expect(CurveDefSchema.safeParse({ ...linear, type: 'quadratic' }).success).toBe(false);
    expect(CurveDefSchema.safeParse({ ...linear, extra: 1 }).success).toBe(false);
  });

  it('rejects non-positive exponential parameters', () => {
    expect(CurveDefSchema.safeParse({ ...exponential, growth: 0 }).success).toBe(false);
  });
});

describe('IdSchema', () => {
  it('accepts kebab-case ascii ids', () => {
    for (const id of ['pla', 'bench-mk1', 'printer-cost-tier1', 'a1']) {
      expect(IdSchema.safeParse(id).success).toBe(true);
      expect(ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    for (const id of ['Bench', 'bench_mk1', '-bench', 'bench-', 'bench mk1', '', 'béta']) {
      expect(IdSchema.safeParse(id).success).toBe(false);
    }
  });

  it('explains why an id was rejected', () => {
    const result = IdSchema.safeParse('Bench');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('ids must be kebab-case ascii');
    }
  });

  it('requires a non-empty display name on every curve', () => {
    expect(CurveDefSchema.safeParse({ ...linear, name: '' }).success).toBe(false);
  });
});
