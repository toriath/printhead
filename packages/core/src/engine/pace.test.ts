import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { PacingContent } from '../content/schema.js';
import { MS_PER_HOUR } from './constants.js';
import { createPaceMapping } from './pace.js';

const pacingWith = (targetHours: number): PacingContent => ({
  ...loadContent(RAW_CONTENT).pacing,
  targetHours,
});

describe('createPaceMapping', () => {
  it('derives paceScale = targetHours / baselineHours', () => {
    expect(createPaceMapping(pacingWith(8)).describe().scale).toBe(1);
    expect(createPaceMapping(pacingWith(4)).describe().scale).toBe(0.5);
    expect(createPaceMapping(pacingWith(16)).describe().scale).toBe(2);
  });

  it('maps simDt = wallDt / paceScale', () => {
    expect(createPaceMapping(pacingWith(8)).toSimDtMs(1000)).toBe(1000);
    expect(createPaceMapping(pacingWith(4)).toSimDtMs(1000)).toBe(2000);
  });

  it('makes a 4 h target advance the simulation exactly twice as fast as 8 h', () => {
    const eight = createPaceMapping(pacingWith(8));
    const four = createPaceMapping(pacingWith(4));
    fc.assert(
      fc.property(fc.double({ min: 0, max: MS_PER_HOUR, noNaN: true }), (wallDtMs) => {
        expect(four.toSimDtMs(wallDtMs)).toBeCloseTo(eight.toSimDtMs(wallDtMs) * 2, 6);
      }),
    );
  });

  it('round-trips wall-clock and sim time', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 64, noNaN: true }),
        fc.double({ min: 0, max: MS_PER_HOUR, noNaN: true }),
        (targetHours, wallDtMs) => {
          const pace = createPaceMapping(pacingWith(targetHours));
          expect(pace.toWallDtMs(pace.toSimDtMs(wallDtMs))).toBeCloseTo(wallDtMs, 6);
        },
      ),
    );
  });

  it('reports the pace it was built from', () => {
    expect(createPaceMapping(pacingWith(6)).describe()).toEqual({
      targetHours: 6,
      baselineHours: 8,
      scale: 0.75,
    });
  });

  it('rejects a degenerate pace', () => {
    expect(() => createPaceMapping({ ...pacingWith(8), baselineHours: 0 })).toThrow(RangeError);
  });
});
