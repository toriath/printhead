import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { createInitialState } from '../state/game-state.js';
import { meltDown, offeredRunModifiers, platesFor } from './prestige.js';
import { computeModifiers, modifierOf } from './upgrades.js';

const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 9 });

describe('run modifiers', () => {
  it('offers a hand of distinct modifiers, the same for the same run, fresh for the next', () => {
    const first = offeredRunModifiers(base, content).map((def) => def.id);
    expect(first).toHaveLength(content.prestige.runModifierOffers);
    expect(new Set(first).size).toBe(first.length);
    expect(offeredRunModifiers(base, content).map((def) => def.id)).toEqual(first);
    const later = { ...base, stats: { ...base.stats, prestigeCount: 5 } };
    const hands = new Set(
      [0, 1, 2, 3, 4, 5].map((run) =>
        offeredRunModifiers({ ...base, stats: { ...base.stats, prestigeCount: run } }, content)
          .map((def) => def.id)
          .join(),
      ),
    );
    expect(hands.size).toBeGreaterThan(1);
    expect(offeredRunModifiers(later, content)).toHaveLength(first.length);
  });

  it('puts the picked modifier in force for the run, and only that run', () => {
    const overdrive = content.prestige.runModifiers.find((def) => def.id === 'overdrive');
    if (overdrive === undefined) {
      throw new Error('expected the overdrive modifier in content');
    }
    const plain = modifierOf(computeModifiers(base, content), 'printSpeedMultiplier', 1);
    const boosted = modifierOf(
      computeModifiers({ ...base, runModifierId: 'overdrive' }, content),
      'printSpeedMultiplier',
      1,
    );
    expect(boosted).toBeGreaterThan(plain);
    // A melt-down hands the next run whatever was picked — and nothing else.
    const melted = meltDown({ ...base, runModifierId: 'overdrive' }, content, curves, null);
    expect(melted.state.runModifierId).toBeNull();
    const picked = meltDown(base, content, curves, 'careful-hands');
    expect(picked.state.runModifierId).toBe('careful-hands');
  });

  it("pays an engraver's run more plates at its melt-down", () => {
    const rich = {
      ...base,
      phaseId: 'prestige',
      resources: { ...base.resources, money: 1e9 },
      stats: { ...base.stats, moneyEarned: 1e9 },
    };
    const plain = platesFor(rich, content, curves);
    const engraved = platesFor({ ...rich, runModifierId: 'engravers-run' }, content, curves);
    expect(plain).toBeGreaterThan(0);
    expect(engraved).toBeGreaterThan(plain);
  });
});
