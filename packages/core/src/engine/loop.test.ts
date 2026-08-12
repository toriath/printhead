import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { MS_PER_HOUR, MS_PER_MINUTE, TICK_MS } from './constants.js';
import { advance, advanceOffline } from './loop.js';
import { createPaceMapping } from './pace.js';

const pacing = loadContent(RAW_CONTENT).pacing;
const paceAt = (targetHours: number) => createPaceMapping({ ...pacing, targetHours });

interface Counter {
  readonly simTimeMs: number;
  readonly ticks: number;
}

const zero: Counter = { simTimeMs: 0, ticks: 0 };
const tick = (state: Counter, simDtMs: number): Counter => ({
  simTimeMs: state.simTimeMs + simDtMs,
  ticks: state.ticks + 1,
});

describe('advance', () => {
  it('uses a fixed 100 ms simulation timestep', () => {
    expect(TICK_MS).toBe(100);
    const result = advance({ state: zero, carrySimMs: 0, wallDtMs: 1000, pace: paceAt(8), tick });
    expect(result.ticks).toBe(10);
    expect(result.state.simTimeMs).toBe(1000);
    expect(result.carrySimMs).toBe(0);
  });

  it('carries the sub-tick remainder to the next call', () => {
    const first = advance({ state: zero, carrySimMs: 0, wallDtMs: 250, pace: paceAt(8), tick });
    expect(first.ticks).toBe(2);
    expect(first.carrySimMs).toBeCloseTo(50, 9);
    const second = advance({
      state: first.state,
      carrySimMs: first.carrySimMs,
      wallDtMs: 250,
      pace: paceAt(8),
      tick,
    });
    expect(second.ticks).toBe(3);
    expect(second.state.simTimeMs).toBe(500);
  });

  it('scales simulation progress with targetHours (4 h == 2x of 8 h)', () => {
    const eight = advance({ state: zero, carrySimMs: 0, wallDtMs: 60_000, pace: paceAt(8), tick });
    const four = advance({ state: zero, carrySimMs: 0, wallDtMs: 60_000, pace: paceAt(4), tick });
    expect(eight.ticks).toBe(600);
    expect(four.ticks).toBe(1200);
    expect(four.state.simTimeMs).toBe(eight.state.simTimeMs * 2);
  });

  it('never runs more than maxTicks and reports the debt as pending', () => {
    const result = advance({
      state: zero,
      carrySimMs: 0,
      wallDtMs: 10_000,
      pace: paceAt(8),
      tick,
      maxTicks: 10,
    });
    expect(result.ticks).toBe(10);
    expect(result.pending).toBe(true);
    expect(result.carrySimMs).toBeCloseTo(9000, 9);
  });

  it('rejects invalid inputs', () => {
    const base = { state: zero, carrySimMs: 0, pace: paceAt(8), tick };
    expect(() => advance({ ...base, wallDtMs: -1 })).toThrow(RangeError);
    expect(() => advance({ ...base, wallDtMs: Number.NaN })).toThrow(RangeError);
    expect(() => advance({ ...base, carrySimMs: -1, wallDtMs: 0 })).toThrow(RangeError);
    expect(() => advance({ ...base, wallDtMs: 0, maxTicks: 0 })).toThrow(RangeError);
  });

  it('is time-additive: advancing t then t equals advancing 2t', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: MS_PER_MINUTE, noNaN: true }), (wallDtMs) => {
        const pace = paceAt(8);
        const once = advance({ state: zero, carrySimMs: 0, wallDtMs: wallDtMs * 2, pace, tick });
        const stepA = advance({ state: zero, carrySimMs: 0, wallDtMs, pace, tick });
        const stepB = advance({
          state: stepA.state,
          carrySimMs: stepA.carrySimMs,
          wallDtMs,
          pace,
          tick,
        });
        expect(stepB.state.ticks).toBe(once.state.ticks);
        expect(stepB.state.simTimeMs).toBeCloseTo(once.state.simTimeMs, 6);
      }),
    );
  });
});

describe('advanceOffline', () => {
  const offline = (wallElapsedMs: number, targetHours = 8) =>
    advanceOffline({
      state: zero,
      carrySimMs: 0,
      wallElapsedMs,
      pace: paceAt(targetHours),
      tick,
      capHours: pacing.offlineCapHours,
    });

  it('runs the same tick path in chunks', () => {
    const result = offline(MS_PER_HOUR);
    expect(result.ticks).toBe(36_000);
    expect(result.chunks).toBe(6);
    expect(result.state.simTimeMs).toBe(MS_PER_HOUR);
  });

  it('caps catch-up at pacing.offlineCapHours', () => {
    const result = offline(MS_PER_HOUR * 48);
    expect(pacing.offlineCapHours).toBe(24);
    expect(result.appliedWallMs).toBe(MS_PER_HOUR * 24);
    expect(result.skippedWallMs).toBe(MS_PER_HOUR * 24);
    expect(result.state.simTimeMs).toBe(MS_PER_HOUR * 24);
  });

  it('scales with pace like the online path', () => {
    expect(offline(MS_PER_HOUR, 4).state.simTimeMs).toBe(MS_PER_HOUR * 2);
  });

  it('offline(2t) equals offline(t) composed with offline(t)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (minutes) => {
        const wallDtMs = minutes * MS_PER_MINUTE;
        const pace = paceAt(8);
        const common = { pace, tick, capHours: pacing.offlineCapHours };
        const once = advanceOffline({
          state: zero,
          carrySimMs: 0,
          wallElapsedMs: wallDtMs * 2,
          ...common,
        });
        const a = advanceOffline({
          state: zero,
          carrySimMs: 0,
          wallElapsedMs: wallDtMs,
          ...common,
        });
        const b = advanceOffline({
          state: a.state,
          carrySimMs: a.carrySimMs,
          wallElapsedMs: wallDtMs,
          ...common,
        });
        expect(b.state).toEqual(once.state);
      }),
      { numRuns: 15 },
    );
  });

  it('rejects invalid inputs', () => {
    expect(() => offline(-1)).toThrow(RangeError);
    expect(() =>
      advanceOffline({
        state: zero,
        carrySimMs: 0,
        wallElapsedMs: 0,
        pace: paceAt(8),
        tick,
        capHours: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      advanceOffline({
        state: zero,
        carrySimMs: 0,
        wallElapsedMs: MS_PER_MINUTE,
        pace: paceAt(8),
        tick,
        capHours: 1,
        chunkWallMs: 0,
      }),
    ).toThrow(RangeError);
  });

  it('honours maxTicks by draining the debt across extra passes', () => {
    const result = advanceOffline({
      state: zero,
      carrySimMs: 0,
      wallElapsedMs: MS_PER_MINUTE,
      pace: paceAt(8),
      tick,
      capHours: 1,
      chunkWallMs: MS_PER_MINUTE,
      maxTicks: 7,
    });
    expect(result.ticks).toBe(600);
    expect(result.chunks).toBe(1);
  });
});
