import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { inflationInput, inflationMultiplier, isInflating } from './inflation.js';
import { quoteFor } from './market.js';

/**
 * On-screen inflation (spec §6 phase 5). The index is *caused* by the player's
 * own money printers, so every case here moves `stats.moneyPrinted` and reads
 * the consequence rather than setting a multiplier by hand.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });
const startPhase = content.endgame.inflation.startPhaseId;

function printed(money: number, over: Partial<GameState> = {}): GameState {
  return {
    ...base,
    phaseId: startPhase,
    stats: { ...base.stats, moneyPrinted: money },
    ...over,
  };
}

describe('the inflation index', () => {
  it('is exactly neutral before the phase content switches it on', () => {
    const early = printed(10_000_000, { phaseId: 'intro' });
    expect(isInflating(early, content)).toBe(false);
    expect(inflationMultiplier(early, content, curves)).toBe(1);
  });

  it('switches on in the phase `endgame.inflation.startPhaseId` names', () => {
    expect(isInflating(printed(0), content)).toBe(true);
  });

  it('is neutral with nothing printed, and rises with what the presses made', () => {
    expect(inflationMultiplier(printed(0), content, curves)).toBe(1);
    const some = inflationMultiplier(printed(1_000_000), content, curves);
    const more = inflationMultiplier(printed(100_000_000), content, curves);
    expect(some).toBeGreaterThan(1);
    expect(more).toBeGreaterThan(some);
  });

  it('reads the metric content names, scaled by content', () => {
    const state = printed(1_000_000);
    expect(inflationInput(state, content)).toBeCloseTo(
      1_000_000 * content.endgame.inflation.inputScale,
      9,
    );
  });

  it('never runs past the ceiling content declares', () => {
    const absurd = printed(Number.MAX_SAFE_INTEGER);
    expect(inflationMultiplier(absurd, content, curves)).toBe(
      content.endgame.inflation.maxMultiplier,
    );
  });

  it('devalues money prices — and leaves Plate prices alone (spec §3)', () => {
    const calm = printed(0);
    const wild = printed(500_000_000);
    const petgCalm = quoteFor(calm, content, 'petg');
    const petgWild = quoteFor(wild, content, 'petg');
    expect(petgWild?.buyPerGram ?? 0).toBeGreaterThan(petgCalm?.buyPerGram ?? 0);
    expect(petgWild?.priceResource).toBe('money');

    // The endgame feedstock is bought with prestige currency, and the presses
    // cannot spoil that: it is the one shelf inflation does not touch.
    const compositeCalm = quoteFor(calm, content, 'composite');
    const compositeWild = quoteFor(wild, content, 'composite');
    expect(compositeWild?.priceResource).toBe('plates');
    expect(compositeWild?.buyPerGram).toBe(compositeCalm?.buyPerGram);
  });
});
