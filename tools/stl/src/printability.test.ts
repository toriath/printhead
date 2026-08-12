import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PARAMS, PRINTABILITY_LIMITS, checkPrintability } from './index.js';

describe('printability contract (spec §20)', () => {
  it('accepts the default max-tier printer', () => {
    expect(checkPrintability(DEFAULT_MODEL_PARAMS)).toEqual([]);
  });

  it('rejects walls thinner than 1.2 mm', () => {
    const issues = checkPrintability({ ...DEFAULT_MODEL_PARAMS, wallThicknessMm: 0.8 });
    expect(issues.map((issue) => issue.rule)).toEqual(['min-wall-thickness']);
  });

  it('rejects models that do not fit a 180 mm bed', () => {
    const issues = checkPrintability({ ...DEFAULT_MODEL_PARAMS, depthMm: 200 });
    expect(issues.map((issue) => issue.rule)).toEqual(['bed-fit']);
  });

  it('pins the printability limits the generator must satisfy', () => {
    expect(PRINTABILITY_LIMITS).toEqual({
      minWallThicknessMm: 1.2,
      maxOverhangDegrees: 45,
      bedSizeMm: 180,
      maxPrintHours: 2,
      layerHeightMm: 0.2,
    });
  });
});
