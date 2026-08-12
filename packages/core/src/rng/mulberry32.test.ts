import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createRng, hashSeed, restoreRng } from './mulberry32.js';

describe('mulberry32 rng', () => {
  it('is deterministic for a given seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const drawsA = [a.next(), a.next(), a.next()];
    const drawsB = [b.next(), b.next(), b.next()];
    expect(drawsA).toEqual(drawsB);
  });

  it('produces different streams for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('stays in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 50 }), (seed, draws) => {
        const rng = createRng(seed);
        for (let i = 0; i < draws; i += 1) {
          const value = rng.next();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('tracks how many draws it has taken', () => {
    const rng = createRng(7);
    rng.next();
    rng.next();
    expect(rng.count).toBe(2);
    expect(rng.snapshot()).toEqual({ seed: 7, count: 2 });
  });

  it('restores exactly from a snapshot', () => {
    const rng = createRng(99);
    rng.next();
    rng.next();
    const expected = rng.next();
    const restored = restoreRng({ seed: 99, count: 2 });
    expect(restored.next()).toBe(expected);
  });

  it('forks independent but reproducible streams', () => {
    const parent = createRng(5);
    const printing = parent.fork('printing');
    const market = parent.fork('market');
    expect(printing.next()).not.toBe(market.next());
    expect(createRng(5).fork('printing').next()).toBe(createRng(5).fork('printing').next());
  });

  it('forks differ once the parent has advanced', () => {
    const parent = createRng(5);
    const before = parent.fork('printing').next();
    parent.next();
    expect(parent.fork('printing').next()).not.toBe(before);
  });

  it('nextInt stays inside the bound', () => {
    const rng = createRng(3);
    for (let i = 0; i < 100; i += 1) {
      const value = rng.nextInt(6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
    }
  });

  it('rejects invalid seeds and bounds', () => {
    expect(() => createRng(1.5)).toThrow(RangeError);
    expect(() => createRng(1).nextInt(0)).toThrow(RangeError);
    expect(() => createRng(1).nextInt(2.5)).toThrow(RangeError);
  });

  it('hashSeed is stable and label-sensitive', () => {
    expect(hashSeed('a', 1)).toBe(hashSeed('a', 1));
    expect(hashSeed('a', 1)).not.toBe(hashSeed('b', 1));
    expect(hashSeed('a', 1)).not.toBe(hashSeed('a', 2));
  });
});
