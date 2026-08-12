import { describe, expect, it } from 'vitest';
import type { Content, UpgradeDef } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  availableMaterialIds,
  computeModifiers,
  countUpgrades,
  installedLevel,
  isInstalled,
  isMaterialAvailable,
  modifierOf,
  nextUpgradeCost,
  purchaseUpgrade,
  upgradeAvailability,
} from './upgrades.js';

const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });

const withUpgrades = (upgrades: Record<string, number>, over: Partial<GameState> = {}): GameState =>
  ({ ...base, upgrades, ...over }) as GameState;

/**
 * The interpreter is tested against *fixture* upgrade defs wherever the point
 * is the folding rule, so a balance change to `upgrades.json` cannot turn these
 * red. Shipped content is checked separately, for shape rather than value.
 */
const fixtureDef = (over: Partial<UpgradeDef>): UpgradeDef =>
  ({
    id: 'test-node',
    name: 'Test node',
    tree: 'machine',
    maxLevel: 3,
    costCurveId: 'upgrade-cost-machine',
    costResource: 'parts',
    requiresUpgradeIds: [],
    unlockPhaseId: 'intro',
    effects: [{ type: 'printSpeedMultiplier', combine: 'multiply', value: 2 }],
    ...over,
  }) as UpgradeDef;

const withDefs = (defs: readonly UpgradeDef[]): Content =>
  ({ ...content, upgrades: defs }) as Content;

describe('installed levels', () => {
  it('reads a level, defaulting to none', () => {
    expect(installedLevel(base, 'heated-bed')).toBe(0);
    expect(installedLevel(withUpgrades({ 'heated-bed': 2 }), 'heated-bed')).toBe(2);
    expect(isInstalled(withUpgrades({ 'heated-bed': 1 }), 'heated-bed')).toBe(true);
    expect(isInstalled(base, 'heated-bed')).toBe(false);
  });

  it('counts levels, not nodes — the phase gate is about investment', () => {
    expect(countUpgrades(base)).toBe(0);
    expect(countUpgrades(withUpgrades({ a: 1, b: 3 }))).toBe(4);
  });
});

describe('computeModifiers', () => {
  it('is empty with nothing installed, and falls back to the caller neutral', () => {
    const modifiers = computeModifiers(base, content);
    expect(modifierOf(modifiers, 'printSpeedMultiplier', 1)).toBe(1);
    expect(modifierOf(modifiers, 'recyclerYieldFraction', 0)).toBe(0);
  });

  it('compounds a multiply effect once per installed level', () => {
    const defs = withDefs([fixtureDef({})]);
    const modifiers = computeModifiers(withUpgrades({ 'test-node': 3 }), defs);
    expect(modifierOf(modifiers, 'printSpeedMultiplier', 1)).toBe(8);
  });

  it('sums an add effect across levels', () => {
    const defs = withDefs([
      fixtureDef({ effects: [{ type: 'machineTier', combine: 'add', value: 2 }] }),
    ]);
    const modifiers = computeModifiers(withUpgrades({ 'test-node': 2 }), defs);
    expect(modifierOf(modifiers, 'machineTier', 0)).toBe(4);
  });

  it('takes the strongest node for a max effect, ignoring level', () => {
    const defs = withDefs([
      fixtureDef({
        id: 'weak',
        effects: [{ type: 'machineTier', combine: 'max', value: 2 }],
      }),
      fixtureDef({
        id: 'strong',
        effects: [{ type: 'machineTier', combine: 'max', value: 3 }],
      }),
    ]);
    expect(modifierOf(computeModifiers(withUpgrades({ weak: 3 }), defs), 'machineTier', 0)).toBe(2);
    expect(
      modifierOf(computeModifiers(withUpgrades({ weak: 1, strong: 1 }), defs), 'machineTier', 0),
    ).toBe(3);
    // Order-independent: the strong node still wins when it is folded first.
    expect(
      modifierOf(computeModifiers(withUpgrades({ strong: 1, weak: 1 }), defs), 'machineTier', 0),
    ).toBe(3);
  });

  it('combines two nodes that touch the same multiplier', () => {
    const defs = withDefs([
      fixtureDef({
        id: 'a',
        effects: [{ type: 'printSpeedMultiplier', combine: 'multiply', value: 2 }],
      }),
      fixtureDef({
        id: 'b',
        effects: [{ type: 'printSpeedMultiplier', combine: 'multiply', value: 3 }],
      }),
    ]);
    const modifiers = computeModifiers(withUpgrades({ a: 1, b: 1 }), defs);
    expect(modifierOf(modifiers, 'printSpeedMultiplier', 1)).toBe(6);
  });

  it('ignores defs that are not installed', () => {
    const defs = withDefs([fixtureDef({})]);
    expect(
      modifierOf(
        computeModifiers(withUpgrades({ 'test-node': 0 }), defs),
        'printSpeedMultiplier',
        1,
      ),
    ).toBe(1);
  });
});

describe('upgradeAvailability', () => {
  it('names the exact reason a node cannot be installed', () => {
    expect(upgradeAvailability(base, content, 'ghost')).toBe('unknown-target');
    // heated-bed unlocks in bench; the fresh state is still in intro.
    expect(upgradeAvailability(base, content, 'heated-bed')).toBe('locked');

    const inBench: GameState = { ...base, phaseId: 'bench' };
    expect(upgradeAvailability(inBench, content, 'heated-bed')).toBeNull();
    expect(upgradeAvailability(inBench, content, 'hardened-nozzle')).toBe('missing-prerequisite');

    const bedded = withUpgrades({ 'heated-bed': 1 }, { phaseId: 'bench' });
    expect(upgradeAvailability(bedded, content, 'heated-bed')).toBe('max-level');
    expect(upgradeAvailability(bedded, content, 'hardened-nozzle')).toBeNull();
  });
});

describe('purchaseUpgrade', () => {
  const inBench: GameState = { ...base, phaseId: 'bench' };

  it('rounds a parts price up — you cannot hand over a fraction of a Part', () => {
    const cost = nextUpgradeCost(inBench, content, curves, 'heated-bed');
    expect(cost?.resource).toBe('parts');
    expect(Number.isInteger(cost?.amount)).toBe(true);
    expect(nextUpgradeCost(inBench, content, curves, 'ghost')).toBeNull();
  });

  it('pays the curve price and records the level', () => {
    const cost = nextUpgradeCost(inBench, content, curves, 'heated-bed');
    const rich: GameState = {
      ...inBench,
      resources: { ...inBench.resources, parts: cost?.amount ?? 0 },
      partsValue: cost?.amount ?? 0,
    };
    const bought = purchaseUpgrade(rich, content, curves, 'heated-bed');
    expect(bought?.level).toBe(1);
    expect(bought?.state.upgrades['heated-bed']).toBe(1);
    expect(bought?.state.resources.parts).toBe(0);
  });

  it('prices each level above the last', () => {
    const first = nextUpgradeCost(inBench, content, curves, 'hardened-nozzle')?.amount ?? 0;
    const second =
      nextUpgradeCost(
        withUpgrades({ 'hardened-nozzle': 1 }, { phaseId: 'bench' }),
        content,
        curves,
        'hardened-nozzle',
      )?.amount ?? 0;
    expect(second).toBeGreaterThan(first);
  });

  it('is null when unaffordable or unknown', () => {
    expect(purchaseUpgrade(inBench, content, curves, 'heated-bed')).toBeNull();
    expect(purchaseUpgrade(inBench, content, curves, 'ghost')).toBeNull();
  });
});

describe('materials are gated by the machine tree as well as the phase', () => {
  it('offers only PLA before anything is bolted on', () => {
    expect(availableMaterialIds({ ...base, phaseId: 'farm' }, content)).toEqual(['pla']);
  });

  it('opens PETG once its required node is installed', () => {
    const bedded = withUpgrades({ 'heated-bed': 1 }, { phaseId: 'bench' });
    expect(isMaterialAvailable(bedded, content, 'petg')).toBe(true);
    // ...but the phase still has the final say.
    expect(isMaterialAvailable({ ...bedded, phaseId: 'intro' }, content, 'petg')).toBe(false);
  });

  it('is false for a material that does not exist', () => {
    expect(isMaterialAvailable(base, content, 'unobtainium')).toBe(false);
  });
});
