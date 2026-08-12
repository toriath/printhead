import { describe, expect, it } from 'vitest';
import type { Content, FailureContent, MaterialDef } from '../content/schema.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  bankScrap,
  chargePerPrint,
  hasRecycler,
  recycleScrapInto,
  recyclerYield,
  resolveBatchFailures,
  scrapFromFailure,
} from './failure.js';
import { computeModifiers } from './upgrades.js';

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 1 });
const pla = content.materials[0] as MaterialDef;
const noModifiers = computeModifiers(base, content);

/** A pity model with round numbers, so the arithmetic under test is visible. */
const pity = (over: Partial<FailureContent['model']> = {}): FailureContent => ({
  model: { strategy: 'pity-timer', chargeThreshold: 1, carryFraction: 0, ...over },
  recycler: content.failure.recycler,
});

const holdingScrap = (grams: number, value: number, over: Partial<GameState> = {}): GameState => ({
  ...base,
  resources: { ...base.resources, scrap: grams },
  scrapValue: value,
  ...over,
});

describe('chargePerPrint', () => {
  it('is the material rate, scaled by the machine and the tree', () => {
    expect(chargePerPrint(pla, 1, noModifiers)).toBeCloseTo(pla.failureChargePerPrint, 9);
    expect(chargePerPrint(pla, 0.5, noModifiers)).toBeCloseTo(pla.failureChargePerPrint / 2, 9);
  });

  it('is reduced by an installed failureChargeMultiplier node', () => {
    const bedded = computeModifiers({ ...base, upgrades: { 'heated-bed': 1 } }, content);
    expect(chargePerPrint(pla, 1, bedded)).toBeLessThan(chargePerPrint(pla, 1, noModifiers));
  });
});

describe('resolveBatchFailures', () => {
  it('fails nothing while the charge stays below the threshold', () => {
    const outcome = resolveBatchFailures(pity(), 0, 3, 0.25);
    expect(outcome).toEqual({ failed: 0, succeeded: 3, charge: 0.75 });
  });

  it('fails exactly the print that crosses the threshold', () => {
    const outcome = resolveBatchFailures(pity(), 0, 4, 0.25);
    expect(outcome.failed).toBe(1);
    expect(outcome.succeeded).toBe(3);
    expect(outcome.charge).toBeCloseTo(0, 9);
  });

  it('carries the charge across batches — the timer is the slot, not the run', () => {
    const first = resolveBatchFailures(pity(), 0, 2, 0.25);
    const second = resolveBatchFailures(pity(), first.charge, 2, 0.25);
    expect(first.failed).toBe(0);
    expect(second.failed).toBe(1);
  });

  it('leaves a share of the threshold behind when content asks it to', () => {
    const outcome = resolveBatchFailures(pity({ carryFraction: 0.5 }), 0, 4, 0.25);
    expect(outcome.charge).toBeCloseTo(0.5, 9);
  });

  it('can fail more than once in a big enough batch', () => {
    const outcome = resolveBatchFailures(pity(), 0, 12, 0.5);
    expect(outcome.failed).toBe(6);
    expect(outcome.succeeded).toBe(6);
  });

  it('never fails under the "never" strategy or a zero charge rate', () => {
    expect(resolveBatchFailures(pity({ strategy: 'never' }), 0.99, 10, 1).failed).toBe(0);
    expect(resolveBatchFailures(pity(), 0.99, 10, 0).failed).toBe(0);
  });

  it('is deterministic: the same inputs always fail in the same places', () => {
    const once = resolveBatchFailures(pity(), 0.3, 9, 0.17);
    const twice = resolveBatchFailures(pity(), 0.3, 9, 0.17);
    expect(twice).toEqual(once);
  });
});

describe('scrapFromFailure', () => {
  it('recovers the material share of the wasted filament, and its value', () => {
    const produced = scrapFromFailure(pla, 10);
    expect(produced.grams).toBeCloseTo(10 * pla.scrapRecoveryFraction, 9);
    expect(produced.value).toBeCloseTo(produced.grams * pla.costPerGram, 9);
  });

  it('banks the scrap and books the stat', () => {
    const banked = bankScrap(base, { grams: 4, value: 0.2 });
    expect(banked.resources.scrap).toBe(4);
    expect(banked.scrapValue).toBeCloseTo(0.2, 9);
    expect(banked.stats.scrapProducedGrams).toBe(4);
  });

  it('ignores an empty yield rather than churning state', () => {
    expect(bankScrap(base, { grams: 0, value: 0 })).toBe(base);
  });
});

describe('the recycler', () => {
  const recyclerId = content.failure.recycler.requiresUpgradeId;
  const installed = { [recyclerId]: 1 };
  const modifiersWith = (state: GameState) => computeModifiers(state, content);

  it('is only available once its machine node is installed', () => {
    expect(hasRecycler(base, content)).toBe(false);
    expect(hasRecycler({ ...base, upgrades: installed }, content)).toBe(true);
    expect(recyclerYield(noModifiers)).toBe(0);
    expect(recyclerYield(modifiersWith({ ...base, upgrades: installed }))).toBeGreaterThan(0);
  });

  it('refuses to run without the node', () => {
    expect(recycleScrapInto(holdingScrap(10, 1), content, noModifiers, 'pla', null)).toBe(
      'no-recycler',
    );
  });

  it('refuses unknown or valueless materials', () => {
    const state = holdingScrap(10, 1, { upgrades: installed });
    expect(recycleScrapInto(state, content, modifiersWith(state), 'ghost', null)).toBe(
      'unknown-target',
    );
    const free: Content = {
      ...content,
      materials: content.materials.map((material) =>
        material.id === 'pla' ? { ...material, costPerGram: 0 } : material,
      ),
    };
    expect(recycleScrapInto(state, free, modifiersWith(state), 'pla', null)).toBe('unknown-target');
  });

  it('refuses an empty scrap bin', () => {
    const state = holdingScrap(0, 0, { upgrades: installed });
    expect(recycleScrapInto(state, content, modifiersWith(state), 'pla', null)).toBe(
      'nothing-to-do',
    );
  });

  it('hands back filament worth strictly less than the scrap went in for', () => {
    const state = holdingScrap(20, 1, { upgrades: installed });
    const result = recycleScrapInto(state, content, modifiersWith(state), 'pla', null);
    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') {
      return;
    }
    const outputValue = result.filamentGrams * pla.costPerGram;
    expect(outputValue).toBeLessThan(1);
    expect(outputValue).toBeCloseTo(1 * content.failure.recycler.yieldFraction, 9);
    expect(result.state.resources.scrap).toBe(0);
    expect(result.state.scrapValue).toBe(0);
    expect(result.state.stats.scrapRecycledGrams).toBe(20);
  });

  it('takes only the requested grams and their pro-rata value', () => {
    const state = holdingScrap(20, 1, { upgrades: installed });
    const result = recycleScrapInto(state, content, modifiersWith(state), 'pla', 5);
    if (typeof result === 'string') {
      throw new Error(result);
    }
    expect(result.scrapGrams).toBe(5);
    expect(result.state.resources.scrap).toBe(15);
    expect(result.state.scrapValue).toBeCloseTo(0.75, 9);
  });

  it('recycling into a dearer material yields proportionally less of it', () => {
    const state = holdingScrap(20, 1, { upgrades: { ...installed, 'heated-bed': 1 } });
    const cheap = recycleScrapInto(state, content, modifiersWith(state), 'pla', null);
    const dear = recycleScrapInto(state, content, modifiersWith(state), 'petg', null);
    if (typeof cheap === 'string' || typeof dear === 'string') {
      throw new Error('expected both recycles to succeed');
    }
    expect(dear.filamentGrams).toBeLessThan(cheap.filamentGrams);
  });
});
