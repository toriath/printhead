import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../engine/constants.js';
import { nextSectionCost } from '../systems/endgame.js';
import { endingTotalMs } from '../systems/ending.js';
import { TEST_CONTENT, createSim, testSlot } from './__fixtures__/sim.js';
import { newGamePlus, printSection, startFabricator, tick } from './actions.js';
import type { GameState } from './game-state.js';

/**
 * The M6 actions through the real reducer (spec §5E, §6 phases 5–6, §7.3).
 * Every case is a sequence of clicks; every rejection is a button the shell
 * must not offer.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const fab = content.endgame.fabricator;
function forkNamed(required: boolean) {
  const def = content.forks.find((candidate) => candidate.requiredForFinalPrint === required);
  if (def === undefined) {
    throw new Error(
      'content must ship one branch that may attempt the final print, and one that may not',
    );
  }
  return def;
}

const goliath = forkNamed(true);
const farm = forkNamed(false);

/** A workshop in the last phase with the tree bought and the feedstock in. */
function endSim(over: Partial<GameState> = {}) {
  const sim = createSim();
  sim.state = {
    ...sim.state,
    phaseId: 'end',
    forkId: goliath.id,
    printers: { [content.start.printerId]: fab.requiredPrinters },
    upgrades: {
      'exotic-feedstock': 1,
      'print-a-building': 1,
      'print-a-factory': 1,
      'universal-fabricator': 1,
    },
    resources: { ...sim.state.resources, parts: 200_000, plates: 400 },
    partsValue: 200_000,
    filamentGrams: { ...sim.state.filamentGrams, composite: fab.filamentGrams * 3 },
    slots: [testSlot({ id: 'slot-1', printerCount: fab.requiredPrinters })],
    ...over,
  };
  return sim;
}

describe('PRINT_SECTION (spec §7.3)', () => {
  it('is refused before the phase that opens the endgame', () => {
    const sim = endSim({ phaseId: 'studio' });
    sim.do(printSection());
    expect(sim.state.fabricator.sectionRun).toBeNull();
    expect(sim.eventsOf('ACTION_REJECTED')[0]?.reason).toBe('phase-gated');
  });

  it('charges for a section, prints it over time and announces it', () => {
    const sim = endSim();
    const cost = nextSectionCost(sim.state, content, curves);
    const before = sim.state.resources.parts;
    sim.do(printSection());
    expect(sim.state.resources.parts).toBe(before - cost.amount);
    sim.tickMs(fab.sectionDesignMinutes * MS_PER_MINUTE);
    expect(sim.state.fabricator.sections).toBe(1);
    expect(sim.eventsOf('FABRICATOR_SECTION_PRINTED')[0]).toMatchObject({
      sections: 1,
      maxSections: fab.maxSections,
    });
  });

  /**
   * The §7.3 promise, end to end: a Farm build cannot attempt the final print,
   * but the sections it prints are its own and they cross the melt-down — which
   * is exactly how a throughput run stays in the running for the last one.
   */
  it('lets a Farm build pre-print work the Goliath run inherits', () => {
    const sim = endSim({ forkId: farm.id });
    sim.do(printSection());
    sim.tickMs(fab.sectionDesignMinutes * MS_PER_MINUTE);
    expect(sim.state.fabricator.sections).toBe(1);
    sim.do(startFabricator());
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('wrong-fork');
    expect(content.prestige.retainedLedgers).toContain('fabricator');
  });
});

describe('START_FABRICATOR (spec §4, §6 phase 6)', () => {
  it('refuses a workshop that has not put its whole fleet behind it', () => {
    const sim = endSim({
      printers: { [content.start.printerId]: 1 },
      slots: [testSlot({ id: 'slot-1', printerCount: 1 })],
    });
    sim.do(startFabricator());
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('slots-not-committed');
  });

  it('commits the workshop, consumes the feedstock and announces the build', () => {
    const sim = endSim({
      slots: [
        testSlot({
          id: 'slot-1',
          materialId: 'pla',
          objectId: 'bracket',
          printerCount: fab.requiredPrinters,
        }),
      ],
    });
    sim.do(startFabricator());
    expect(sim.state.fabricator.run?.totalMs).toBe(fab.designMinutes * MS_PER_MINUTE);
    expect(sim.state.slots[0]?.materialId).toBeNull();
    expect(sim.state.slots[0]?.printerCount).toBe(fab.requiredPrinters);
    expect(sim.eventsOf('FABRICATOR_STARTED')[0]).toMatchObject({
      sections: 0,
      slotsCommitted: 1,
    });
  });

  it('runs to the end, then plays the ending and closes the arc (spec §6)', () => {
    const sim = endSim();
    sim.do(startFabricator());
    sim.tickMs(fab.designMinutes * MS_PER_MINUTE);
    expect(sim.state.fabricator.completedAtMs).not.toBeNull();
    expect(sim.eventsOf('FABRICATOR_COMPLETED')).toHaveLength(1);
    // Still in `end`: the credits have to print out first.
    expect(sim.state.phaseId).toBe('end');
    sim.tickMs(endingTotalMs(content));
    expect(sim.eventsOf('GAME_ENDED')).toHaveLength(1);
    expect(sim.state.phaseId).toBe('ended');
    // ...and the announcement is made exactly once, however long it runs on.
    sim.tickMs(MS_PER_MINUTE);
    expect(sim.eventsOf('GAME_ENDED')).toHaveLength(1);
  });

  it('cannot be started twice', () => {
    const sim = endSim();
    sim.do(startFabricator(), startFabricator());
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('slot-busy');
  });
});

describe('NEW_GAME_PLUS (spec §18 M6)', () => {
  /** Play the last print out, credits and all, so the post-game is reachable. */
  function finishTheGame() {
    const sim = endSim({
      designs: { 'money-plate': { level: 3, printsOnLevel: 1 } },
      resources: {
        ...endSim().state.resources,
        designs: 1,
      },
    });
    sim.do(startFabricator());
    sim.tickMs(fab.designMinutes * MS_PER_MINUTE + endingTotalMs(content) + MS_PER_SECOND);
    return sim;
  }

  /**
   * Two gates, one after the other: the phase FSM does not offer the button
   * until the sandbox, and `newGamePlusAvailability` refuses it until the
   * credits have finished (proved directly in `systems/endgame.test.ts`).
   */
  it('is refused while the credits are still rolling', () => {
    const sim = endSim();
    sim.do(startFabricator());
    sim.tickMs(fab.designMinutes * MS_PER_MINUTE);
    sim.do(newGamePlus([]));
    expect(sim.state.phaseId).toBe('end');
    expect(sim.eventsOf('ACTION_REJECTED').at(-1)?.reason).toBe('phase-gated');
  });

  it('starts a new run keeping the Designs, and records the modifiers taken', () => {
    const sim = finishTheGame();
    expect(sim.state.phaseId).toBe('ended');
    const modifier = content.endgame.newGamePlus.modifiers[0];
    if (modifier === undefined) {
      throw new Error('content must offer a modifier');
    }
    sim.do(newGamePlus([modifier.id]));
    expect(sim.state.ngPlus).toEqual({ run: 1, modifierIds: [modifier.id] });
    expect(sim.state.designs['money-plate']).toEqual({ level: 3, printsOnLevel: 1 });
    expect(sim.state.phaseId).toBe(content.pacing.phases[0]?.id);
    expect(sim.state.simTimeMs).toBe(0);
    expect(sim.state.upgrades).toEqual({});
    expect(sim.eventsOf('NEW_GAME_PLUS_STARTED')[0]).toMatchObject({
      run: 1,
      designsKept: 1,
    });
  });
});

/**
 * Spec §15: the FSM runs "Intro → … → Ended". `ended` is the terminal state and
 * the post-game sandbox — nothing advances out of it, and it still ticks.
 */
describe('the phase FSM reaches Ended and rests there', () => {
  it('keeps running the workshop in the post-game sandbox', () => {
    const sim = endSim({ moneyPrinters: { 'bill-printer': 1 } });
    sim.state = { ...sim.state, resources: { ...sim.state.resources, plates: 10 } };
    sim.do(startFabricator());
    sim.tickMs(fab.designMinutes * MS_PER_MINUTE + endingTotalMs(content) + MS_PER_SECOND);
    expect(sim.state.phaseId).toBe('ended');
    const banked = sim.state.resources.money;
    sim.do(tick(MS_PER_SECOND));
    // The presses keep printing: the sandbox is the game still running, not a
    // screenshot of it.
    expect(sim.state.resources.money).toBeGreaterThan(banked);
    expect(sim.state.phaseId).toBe('ended');
  });
});
