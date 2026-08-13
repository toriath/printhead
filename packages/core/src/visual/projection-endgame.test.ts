import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../engine/constants.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { endingTotalMs } from '../systems/ending.js';
import { inflationMultiplier } from '../systems/inflation.js';
import { toVisualState } from './visual-state.js';

/**
 * What the endgame projects (spec §5E, §6 phases 5–6). Pinned by value: the
 * renderer and the shell read nothing else, so a number that drifts here is a
 * number that drifts on screen.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 5 });
const fab = content.endgame.fabricator;
function finalPrintFork() {
  const def = content.forks.find((candidate) => candidate.requiredForFinalPrint);
  if (def === undefined) {
    throw new Error('content must ship a fork that may attempt the final print');
  }
  return def;
}

const goliath = finalPrintFork();

function endgameState(over: Partial<GameState> = {}): GameState {
  return {
    ...base,
    phaseId: 'end',
    forkId: goliath.id,
    printers: { [content.start.printerId]: fab.requiredPrinters },
    upgrades: {
      'exotic-feedstock': 1,
      'print-a-building': 1,
      'print-a-factory': 1,
      'universal-fabricator': 1,
    },
    resources: { ...base.resources, plates: 100, parts: 100_000 },
    partsValue: 100_000,
    filamentGrams: { ...base.filamentGrams, composite: fab.filamentGrams },
    slots: [testSlot({ id: 'slot-1', printerCount: fab.requiredPrinters })],
    stats: { ...base.stats, moneyPrinted: 5_000_000, platesEarned: 100 },
    ...over,
  };
}

describe('the backdrop (spec §5E)', () => {
  it('is the default until the building is printed, and the city after', () => {
    expect(toVisualState(base, content).backdrop).toBe(content.endgame.backdrops[0]?.id);
    expect(toVisualState(endgameState(), content).backdrop).toBe('skyline');
  });
});

describe('on-screen inflation (spec §6 phase 5)', () => {
  it('carries the index and the reading that caused it', () => {
    const visual = toVisualState(endgameState(), content).inflation;
    expect(visual.active).toBe(true);
    expect(visual.moneyPrinted).toBe(5_000_000);
    expect(visual.multiplier).toBe(inflationMultiplier(endgameState(), content, curves));
    expect(visual.multiplier).toBeGreaterThan(1);
  });

  it('is neutral and switched off before the phase content names', () => {
    const early = toVisualState({ ...endgameState(), phaseId: 'bench' }, content).inflation;
    expect(early).toEqual({ active: false, multiplier: 1, moneyPrinted: 5_000_000 });
  });
});

describe('the Universal Fabricator (spec §6 phase 6)', () => {
  it('projects the offer, the feedstock and the commitment', () => {
    const visual = toVisualState(endgameState(), content).fabricator;
    expect(visual).toMatchObject({
      unlocked: true,
      available: true,
      blockedReason: null,
      running: false,
      complete: false,
      layer: 0,
      layers: fab.layers,
      materialId: fab.materialId,
      filamentGrams: fab.filamentGrams,
      heldGrams: fab.filamentGrams,
      sections: 0,
      maxSections: fab.maxSections,
      forkAllows: true,
      slotsCommitted: true,
      committedPrinters: fab.requiredPrinters,
      requiredPrinters: fab.requiredPrinters,
    });
    expect(visual.totalMs).toBe(fab.designMinutes * MS_PER_MINUTE);
  });

  it('says why it is not on offer, in the reducer’s own words (spec §7.3)', () => {
    const farm = toVisualState(endgameState({ forkId: null }), content).fabricator;
    expect(farm.available).toBe(false);
    expect(farm.blockedReason).toBe('wrong-fork');
    expect(farm.forkAllows).toBe(false);
  });

  /** The synced render: the layer is the run's own progress, nothing else. */
  it('counts layers while it prints', () => {
    const half = endgameState({
      fabricator: {
        ...base.fabricator,
        run: {
          remainingMs: (fab.designMinutes / 2) * MS_PER_MINUTE,
          totalMs: fab.designMinutes * MS_PER_MINUTE,
        },
      },
    });
    const visual = toVisualState(half, content).fabricator;
    expect(visual.running).toBe(true);
    expect(visual.progress).toBeCloseTo(0.5, 6);
    expect(visual.layer).toBe(Math.floor(fab.layers / 2));
    expect(visual.remainingMs).toBe((fab.designMinutes / 2) * MS_PER_MINUTE);
  });
});

describe('the ending (spec §6 phase 6)', () => {
  const finished = (elapsedSeconds: number): GameState =>
    endgameState({
      simTimeMs: MS_PER_MINUTE + elapsedSeconds * MS_PER_SECOND,
      fabricator: { ...base.fabricator, completedAtMs: MS_PER_MINUTE },
    });

  it('is dormant until the last print lands', () => {
    const visual = toVisualState(endgameState(), content).ending;
    expect(visual).toMatchObject({ stage: 'none', active: false, infinite: false, creditLines: 0 });
    expect(visual.credits).toEqual(content.endgame.ending.credits);
  });

  it('prints the credits out a line at a time, then offers a new run', () => {
    const { credits } = content.endgame.ending;
    const rolling = toVisualState(
      finished(
        content.endgame.ending.numbersDesignSeconds + content.endgame.ending.museumDesignSeconds,
      ),
      content,
    ).ending;
    expect(rolling.stage).toBe('credits');
    expect(rolling.infinite).toBe(true);
    expect(rolling.creditLines).toBeGreaterThan(0);
    expect(rolling.creditLines).toBeLessThan(credits.length);
    expect(rolling.newGamePlusAvailable).toBe(false);

    const done = toVisualState(finished(endingTotalMs(content) / MS_PER_SECOND), content).ending;
    expect(done.stage).toBe('complete');
    expect(done.creditLines).toBe(credits.length);
    expect(done.newGamePlusAvailable).toBe(true);
    expect(done.modifiers.map((modifier) => modifier.modifierId)).toEqual(
      content.endgame.newGamePlus.modifiers.map((def) => def.id),
    );
    expect(done.modifiers.every((modifier) => !modifier.active)).toBe(true);
  });

  it('marks the modifiers the run was started with', () => {
    const veteran = content.endgame.newGamePlus.modifiers[0];
    if (veteran === undefined) {
      throw new Error('content must offer a modifier');
    }
    const state = endgameState({ ngPlus: { run: 2, modifierIds: [veteran.id] } });
    const visual = toVisualState(state, content).ending;
    expect(visual.newGamePlusRun).toBe(2);
    expect(visual.modifiers.find((entry) => entry.modifierId === veteran.id)?.active).toBe(true);
  });
});
