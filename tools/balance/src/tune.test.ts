import { RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { buildBudgetTable } from './budget.js';
import { PointerError, readPointer, writePointer } from './pointer.js';
import { measurePhase, roundSignificant, tunePhase, withOverrides } from './tune.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The bundled curve the tuner points at, narrowed once for the whole file. */
const printerCurve = () => {
  const curve = loadContent(RAW_CONTENT).curves.find((c) => c.id === 'printer-cost-tier1');
  if (curve === undefined || curve.type !== 'exponential') {
    throw new Error('expected an exponential printer cost curve');
  }
  return curve;
};

describe('content pointers', () => {
  it('addresses array elements by id, not by index', () => {
    expect(readPointer(RAW_CONTENT, 'curves/printer-cost-tier1/base')).toEqual([
      printerCurve().base,
    ]);
  });

  it('fans out over every element with a wildcard', () => {
    const seconds = readPointer(RAW_CONTENT, 'start/assemblyPieces/*/attachDesignSeconds');
    expect(seconds).toHaveLength(loadContent(RAW_CONTENT).start.assemblyPieces.length);
  });

  it('reads plain object fields', () => {
    expect(readPointer(RAW_CONTENT, 'pacing/targetHours')).toEqual([8]);
  });

  it('writes every selected value without touching the original', () => {
    const candidate = clone(RAW_CONTENT);
    const pointer = 'start/assemblyPieces/*/attachDesignSeconds';
    const count = readPointer(candidate, pointer).length;
    writePointer(candidate, pointer, 11);
    expect(readPointer(candidate, pointer)).toEqual(Array.from({ length: count }, () => 11));
    expect(readPointer(RAW_CONTENT, pointer)).not.toContain(11);
  });

  it('writes a single id-addressed field', () => {
    const candidate = clone(RAW_CONTENT);
    writePointer(candidate, 'curves/printer-cost-tier1/growth', 2);
    expect(readPointer(candidate, 'curves/printer-cost-tier1/growth')).toEqual([2]);
    expect(readPointer(candidate, 'curves/upgrade-cost-machine/growth')).not.toEqual([2]);
  });

  it('refuses pointers that do not resolve', () => {
    expect(() => readPointer(RAW_CONTENT, '')).toThrow(PointerError);
    expect(() => readPointer(RAW_CONTENT, 'nope/base')).toThrow(/no field "nope"/);
    expect(() => readPointer(RAW_CONTENT, 'curves/ghost/base')).toThrow(/no array element/);
    expect(() => readPointer(RAW_CONTENT, 'pacing/targetHours/deeper')).toThrow(
      /cannot descend into number/,
    );
    expect(() => readPointer(RAW_CONTENT, 'curves/printer-cost-tier1/name')).toThrow(
      /expected a number/,
    );
    expect(() => writePointer(clone(RAW_CONTENT), 'curves/printer-cost-tier1/nope', 1)).toThrow(
      /no field "nope"/,
    );
  });
});

describe('withOverrides', () => {
  it('produces a valid content set with the field replaced', () => {
    const patched = withOverrides(RAW_CONTENT, { 'curves/printer-cost-tier1/base': 99 });
    expect(readPointer(patched, 'curves/printer-cost-tier1/base')).toEqual([99]);
    expect(printerCurve().base).not.toBe(99);
    // Still a valid content set, not just a mutated blob.
    expect(loadContent(patched).pacing.targetHours).toBe(8);
  });
});

describe('tunePhase', () => {
  /**
   * The tuner's whole job is to make a phase land on its budget by moving a
   * *data* field. Bench is gated on owning printers, so a dearer cost curve is
   * a slower bench — the monotonicity bisection relies on.
   */
  it('makes a dearer printer curve a longer bench phase', () => {
    const cheap = measurePhase(
      withOverrides(RAW_CONTENT, { 'curves/printer-cost-tier1/base': 20 }),
      'bench',
    );
    const dear = measurePhase(
      withOverrides(RAW_CONTENT, { 'curves/printer-cost-tier1/base': 200 }),
      'bench',
    );
    expect(dear).toBeGreaterThan(cheap);
  });

  it('bisects a field until the phase hits its budget', () => {
    const result = tunePhase(
      {
        pointer: 'curves/printer-cost-tier1/base',
        phaseId: 'bench',
        lo: 10,
        hi: 400,
        iterations: 8,
      },
      { raw: RAW_CONTENT },
    );
    expect(result.budgetDesignMinutes).toBe(26);
    expect(result.steps).toHaveLength(8);
    // The bisection aims well inside the gate: ±20 % of the budget.
    expect(result.actualDesignMinutes).toBeGreaterThanOrEqual(26 * 0.8);
    expect(result.actualDesignMinutes).toBeLessThanOrEqual(26 * 1.2);
  });

  it('confirms the shipped content is what the tuner would pick', () => {
    // A regression guard on the committed data diff: the bundled numbers must
    // still put bench inside the window the content itself declares.
    const bench = buildBudgetTable(loadContent(RAW_CONTENT).pacing).phases.find(
      (phase) => phase.phaseId === 'bench',
    );
    expect(measurePhase(RAW_CONTENT, 'bench')).toBeGreaterThanOrEqual(bench?.minDesignMinutes ?? 0);
    expect(measurePhase(RAW_CONTENT, 'bench')).toBeLessThanOrEqual(bench?.maxDesignMinutes ?? 0);
  });
});

describe('roundSignificant', () => {
  it('turns an optimiser artefact into a number a reviewer can read', () => {
    expect(roundSignificant(199.34029440000003)).toBe(199.34);
    expect(roundSignificant(8.0291596)).toBe(8.02916);
    expect(roundSignificant(0.000123456789)).toBe(0.000123457);
  });

  it('moves a value by far less than the balance tolerance', () => {
    for (const value of [1.2345678, 55.5555555, 0.0987654321, 12345.6789]) {
      expect(Math.abs(roundSignificant(value) - value) / value).toBeLessThan(1e-5);
    }
  });

  it('leaves whole numbers, zero and non-finite values alone', () => {
    expect(roundSignificant(42)).toBe(42);
    expect(roundSignificant(0)).toBe(0);
    expect(roundSignificant(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps the sign', () => {
    expect(roundSignificant(-1.23456789)).toBe(-1.23457);
  });
});
