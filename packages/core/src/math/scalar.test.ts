import { describe, expect, it } from 'vitest';
import { TAU, clamp, signedUnit } from './scalar.js';

describe('TAU', () => {
  it('is a full turn', () => {
    expect(Math.sin(TAU)).toBeCloseTo(0, 12);
    expect(Math.cos(TAU)).toBeCloseTo(1, 12);
    expect(Math.sin(TAU / 4)).toBeCloseTo(1, 12);
  });
});

describe('signedUnit', () => {
  it('maps the unit interval onto a symmetric one', () => {
    expect(signedUnit(0)).toBe(-1);
    expect(signedUnit(0.5)).toBe(0);
    expect(signedUnit(1)).toBe(1);
    expect(signedUnit(0.75)).toBeCloseTo(0.5, 12);
  });
});

describe('clamp', () => {
  it('holds a value inside its bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(3, 3, 3)).toBe(3);
  });

  it('refuses inverted bounds instead of silently returning the wrong end', () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
