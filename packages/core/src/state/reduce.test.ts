import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { TICK_MS } from '../engine/constants.js';
import { createRng } from '../rng/mulberry32.js';
import { advancePhase, tick } from './actions.js';
import { type ReduceContext, createInitialState } from './game-state.js';
import { reduce } from './reduce.js';

const content = loadContent(RAW_CONTENT);
const ctx: ReduceContext = { content, nowMs: 0, rng: createRng(1) };
const initial = createInitialState(content, { seed: 1 });

describe('reduce', () => {
  it('starts in the first content phase with an empty clock', () => {
    expect(initial).toEqual({
      saveVersion: 1,
      simTimeMs: 0,
      tickCount: 0,
      phaseId: 'intro',
      rng: { seed: 1, count: 0 },
    });
  });

  it('advances sim time and tick count on TICK', () => {
    const next = reduce(initial, tick(TICK_MS), ctx);
    expect(next.simTimeMs).toBe(TICK_MS);
    expect(next.tickCount).toBe(1);
  });

  it('is pure — the input state is never mutated', () => {
    const before = { ...initial };
    reduce(initial, tick(TICK_MS), ctx);
    expect(initial).toEqual(before);
  });

  it('is deterministic for the same (state, action, ctx)', () => {
    expect(reduce(initial, tick(TICK_MS), ctx)).toEqual(reduce(initial, tick(TICK_MS), ctx));
  });

  it('rejects negative timesteps', () => {
    expect(() => reduce(initial, tick(-1), ctx)).toThrow(RangeError);
    expect(() => reduce(initial, tick(Number.NaN), ctx)).toThrow(RangeError);
  });

  it('walks the phase FSM and clamps at the last phase', () => {
    let state = initial;
    for (let i = 0; i < content.pacing.phases.length; i += 1) {
      state = reduce(state, advancePhase(), ctx);
    }
    expect(state.phaseId).toBe('end');
    expect(reduce(state, advancePhase(), ctx).phaseId).toBe('end');
  });
});
