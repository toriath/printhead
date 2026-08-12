import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import { createRng } from '../rng/mulberry32.js';
import { tick } from '../state/actions.js';
import { type ReduceContext, createInitialState } from '../state/game-state.js';
import { reduce } from '../state/reduce.js';
import { VISUAL_STATE_VERSION, toVisualState } from './visual-state.js';

const content = loadContent(RAW_CONTENT);
const ctx: ReduceContext = { content, nowMs: 0, rng: createRng(1) };
const state = createInitialState(content, { seed: 1 });

describe('toVisualState', () => {
  it('emits a versioned projection', () => {
    expect(toVisualState(state)).toEqual({
      version: VISUAL_STATE_VERSION,
      phaseId: 'intro',
      simTimeMs: 0,
      slots: [],
    });
  });

  it('is a pure function of GameState', () => {
    expect(toVisualState(state)).toEqual(toVisualState(state));
  });

  it('tracks sim time so the renderer can animate without reading internals', () => {
    const advanced = reduce(state, tick(100), ctx);
    expect(toVisualState(advanced).simTimeMs).toBe(100);
  });
});
