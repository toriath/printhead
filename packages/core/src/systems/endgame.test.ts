import { describe, expect, it } from 'vitest';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../engine/constants.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  allSlotsCommitted,
  beginFabricatorPrint,
  buildProgress,
  currentBackdropId,
  currentLayer,
  fabricatorAvailability,
  fabricatorDurationMs,
  factoryRate,
  forkAllowsFinalPrint,
  hasBlueprint,
  newGamePlusAvailability,
  newGamePlusModifiers,
  nextSectionCost,
  sectionAvailability,
  startNewGamePlus,
  startSection,
  tickFabricator,
  tickFactory,
} from './endgame.js';
import { endingProgress, endingStage, endingTotalMs, isEndingComplete } from './ending.js';
import { computeModifiers, countEndgameNodes } from './upgrades.js';

/**
 * The Endgame (spec §5E, §6 phases 5–6, §7.3). Every case builds the state it
 * needs and asks the same functions the reducer asks, so a rule proved here is
 * the rule the game enforces.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });
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

/** A workshop deep in the endgame: the whole tree, a staffed bay, feedstock. */
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
    resources: { ...base.resources, parts: 500_000, plates: 500 },
    partsValue: 500_000,
    filamentGrams: { ...base.filamentGrams, composite: fab.filamentGrams * 4 },
    slots: [testSlot({ id: 'slot-1', printerCount: fab.requiredPrinters })],
    ...over,
  };
}

describe('the Endgame Tree (spec §5E)', () => {
  it('counts only the levels installed in its own tree', () => {
    expect(countEndgameNodes(base, content)).toBe(0);
    const mixed = { ...base, upgrades: { 'heated-bed': 1, 'exotic-feedstock': 1 } };
    expect(countEndgameNodes(mixed, content)).toBe(1);
  });

  it('changes the backdrop when the building is printed (spec §5E)', () => {
    const first = content.endgame.backdrops[0];
    const printed = content.endgame.backdrops.find((def) => def.requiresUpgradeId !== null);
    if (first === undefined || printed === undefined || printed.requiresUpgradeId === null) {
      throw new Error('content must ship a default backdrop and one a node unlocks');
    }
    expect(currentBackdropId(base, content)).toBe(first.id);
    const built = { ...base, upgrades: { [printed.requiresUpgradeId]: 1 } };
    expect(currentBackdropId(built, content)).toBe(printed.id);
  });
});

describe('the printed factory (spec §5E)', () => {
  const withFactory = (over: Partial<GameState> = {}): GameState =>
    endgameState({
      upgrades: { 'exotic-feedstock': 1, 'print-a-building': 1, 'print-a-factory': 1 },
      // An empty rack, so what the factory produces is the only thing in it.
      printers: {},
      slots: [testSlot({ id: 'slot-1', printerCount: 0 })],
      ...over,
    });

  it('does nothing at all without the node', () => {
    const modifiers = computeModifiers(base, content);
    expect(factoryRate(modifiers)).toBe(0);
    expect(tickFactory(base, content, MS_PER_MINUTE, modifiers, undefined)).toBe(base);
  });

  it('turns out whole machines over design time and banks the fraction', () => {
    const state = withFactory();
    const modifiers = computeModifiers(state, content);
    const rate = factoryRate(modifiers);
    expect(rate).toBeGreaterThan(0);
    const minutes = 1 / rate;
    const after = tickFactory(state, content, minutes * MS_PER_MINUTE, modifiers, undefined);
    expect(after.printers[content.start.printerId]).toBe(1);
    expect(after.slots[0]?.printerCount).toBe(1);
    expect(after.factoryProgress).toBeCloseTo(0, 9);
  });

  it('is exactly time-additive, so an offline catch-up agrees (spec §13)', () => {
    const state = withFactory();
    const modifiers = computeModifiers(state, content);
    const oneGo = tickFactory(state, content, 10 * MS_PER_MINUTE, modifiers, undefined);
    let stepped = state;
    for (let step = 0; step < 10; step += 1) {
      stepped = tickFactory(stepped, content, MS_PER_MINUTE, modifiers, undefined);
    }
    expect(stepped.printers).toEqual(oneGo.printers);
    expect(stepped.factoryProgress).toBeCloseTo(oneGo.factoryProgress, 9);
  });

  it('never houses a machine a full rack has nowhere to put (spec §4)', () => {
    const capacity = goliath.printersPerSlot ?? content.start.printersPerSlot;
    const full = withFactory({
      printers: { [content.start.printerId]: capacity },
      slots: [testSlot({ id: 'slot-1', printerCount: capacity })],
    });
    const modifiers = computeModifiers(full, content);
    const after = tickFactory(full, content, 1000 * MS_PER_MINUTE, modifiers, undefined);
    expect(after.slots[0]?.printerCount).toBe(capacity);
    // The accumulator is held at one finished machine rather than banking a
    // backlog the player would be handed the moment a bay opens.
    expect(after.factoryProgress).toBe(1);
  });
});

describe('pre-printed sections (spec §7.3)', () => {
  it('needs the blueprint before anything can be pre-printed', () => {
    const noBlueprint = endgameState({ upgrades: {} });
    expect(hasBlueprint(noBlueprint, content)).toBe(false);
    expect(sectionAvailability(noBlueprint, content, curves)).toBe('locked');
  });

  it('charges the curve and the feedstock, and takes the content’s time', () => {
    const state = endgameState();
    const cost = nextSectionCost(state, content, curves);
    const started = startSection(state, content, curves);
    if (started === null) {
      throw new Error('a funded workshop must be able to start a section');
    }
    expect(started.state.resources.parts).toBe(state.resources.parts - cost.amount);
    expect(started.state.filamentGrams.composite).toBe(
      (state.filamentGrams.composite ?? 0) - fab.sectionFilamentGrams,
    );
    expect(started.state.fabricator.sectionRun).toEqual({
      remainingMs: fab.sectionDesignMinutes * MS_PER_MINUTE,
      totalMs: fab.sectionDesignMinutes * MS_PER_MINUTE,
    });
  });

  it('finishes on the tick its clock runs out, and only one at a time', () => {
    const started = startSection(endgameState(), content, curves);
    if (started === null) {
      throw new Error('expected a section to start');
    }
    expect(sectionAvailability(started.state, content, curves)).toBe('slot-busy');
    const done = tickFabricator(
      started.state,
      content,
      fab.sectionDesignMinutes * MS_PER_MINUTE,
      undefined,
    );
    expect(done.fabricator.sectionRun).toBeNull();
    expect(done.fabricator.sections).toBe(1);
  });

  it('stops at the ceiling content declares', () => {
    const maxed = endgameState({
      fabricator: { ...base.fabricator, sections: fab.maxSections },
    });
    expect(sectionAvailability(maxed, content, curves)).toBe('max-level');
  });

  it('refuses when the feedstock is not in stock', () => {
    const dry = endgameState({ filamentGrams: { ...base.filamentGrams, composite: 0 } });
    expect(sectionAvailability(dry, content, curves)).toBe('insufficient-resources');
  });

  it('is nothing to do once the Fabricator has been built', () => {
    const built = endgameState({
      fabricator: { ...base.fabricator, completedAtMs: MS_PER_MINUTE },
    });
    expect(sectionAvailability(built, content, curves)).toBe('already-built');
  });
});

describe('the Universal Fabricator (spec §6 phase 6)', () => {
  it('refuses every build the run has not earned, with the reason why', () => {
    expect(fabricatorAvailability(endgameState({ upgrades: {} }), content)).toBe('locked');
    // Spec §7.3: only the fork that declares itself may attempt the print.
    const onFarm = endgameState({ forkId: farm.id });
    expect(forkAllowsFinalPrint(onFarm, content)).toBe(false);
    expect(fabricatorAvailability(onFarm, content)).toBe('wrong-fork');
    // Spec §4: all slots committed — a bay with no machine cannot contribute.
    // A rack with an empty bay is only *reachable* on a branch that keeps its
    // bays, so the fork rule is relaxed for this one case; the point being made
    // is about the rack, not about the fork.
    const anyFork = {
      ...content,
      forks: content.forks.map((def) => ({ ...def, requiredForFinalPrint: true })),
    };
    const halfManned = endgameState({
      forkId: farm.id,
      slots: [
        testSlot({ id: 'slot-1', printerCount: fab.requiredPrinters }),
        testSlot({ id: 'slot-2' }),
      ],
    });
    expect(allSlotsCommitted(halfManned, anyFork)).toBe(false);
    expect(fabricatorAvailability(halfManned, anyFork)).toBe('slots-not-committed');
    // ...and a workshop that has not built enough machines is not committed
    // either, however few bays it is running (spec §4).
    const thin = endgameState({
      printers: { [content.start.printerId]: fab.requiredPrinters - 1 },
      slots: [testSlot({ id: 'slot-1', printerCount: fab.requiredPrinters - 1 })],
    });
    expect(fabricatorAvailability(thin, content)).toBe('slots-not-committed');
    const dry = endgameState({ filamentGrams: { ...base.filamentGrams, composite: 0 } });
    expect(fabricatorAvailability(dry, content)).toBe('insufficient-resources');
  });

  it('allows any build when no fork claims the final print', () => {
    const openContent = {
      ...content,
      forks: content.forks.map((def) => ({ ...def, requiredForFinalPrint: false })),
    };
    expect(forkAllowsFinalPrint(endgameState({ forkId: null }), openContent)).toBe(true);
  });

  it('is shortened by pre-printed sections, down to the content floor', () => {
    const none = fabricatorDurationMs(endgameState(), content);
    expect(none).toBe(fab.designMinutes * MS_PER_MINUTE);
    const two = fabricatorDurationMs(
      endgameState({ fabricator: { ...base.fabricator, sections: 2 } }),
      content,
    );
    expect(two).toBeCloseTo((fab.designMinutes - 2 * fab.sectionDesignMinutes) * MS_PER_MINUTE, 6);
    const many = fabricatorDurationMs(
      endgameState({ fabricator: { ...base.fabricator, sections: 10_000 } }),
      content,
    );
    expect(many).toBe(fab.minDesignMinutes * MS_PER_MINUTE);
  });

  it('commits every bay: the configs go, the machines stay (spec §4)', () => {
    const state = endgameState({
      slots: [
        testSlot({
          id: 'slot-1',
          materialId: 'pla',
          objectId: 'bracket',
          printerCount: fab.requiredPrinters,
          autoRestart: true,
          run: { remainingMs: 100, totalMs: 200, batch: 4 },
          queue: [{ materialId: 'pla', objectId: 'bracket', batches: 2 }],
        }),
      ],
    });
    const committed = beginFabricatorPrint(state, content);
    if (committed === null) {
      throw new Error('a committed workshop must be able to start the final print');
    }
    const bay = committed.slots[0];
    expect(bay?.printerCount).toBe(fab.requiredPrinters);
    expect(bay?.materialId).toBeNull();
    expect(bay?.run).toBeNull();
    expect(bay?.queue).toEqual([]);
    expect(committed.filamentGrams.composite).toBe(
      (state.filamentGrams.composite ?? 0) - fab.filamentGrams,
    );
    expect(committed.fabricator.run?.totalMs).toBe(fab.designMinutes * MS_PER_MINUTE);
  });

  it('renders layer by layer from the projection’s own numbers (spec §6)', () => {
    const started = beginFabricatorPrint(endgameState(), content);
    if (started === null) {
      throw new Error('expected the final print to start');
    }
    expect(currentLayer(started, content)).toBe(0);
    const half = tickFabricator(
      started,
      content,
      (fab.designMinutes / 2) * MS_PER_MINUTE,
      undefined,
    );
    expect(buildProgress(half.fabricator.run)).toBeCloseTo(0.5, 6);
    expect(currentLayer(half, content)).toBe(Math.floor(fab.layers / 2));
    const done = tickFabricator(half, content, fab.designMinutes * MS_PER_MINUTE, undefined);
    expect(done.fabricator.run).toBeNull();
    expect(done.fabricator.completedAtMs).toBe(done.simTimeMs);
    expect(currentLayer(done, content)).toBe(fab.layers);
    expect(fabricatorAvailability(done, content)).toBe('already-built');
  });
});

describe('the ending (spec §6 phase 6)', () => {
  const { numbersDesignSeconds, museumDesignSeconds } = content.endgame.ending;
  const finishedAt = (elapsedSeconds: number): GameState =>
    endgameState({
      simTimeMs: MS_PER_MINUTE + elapsedSeconds * MS_PER_SECOND,
      fabricator: { ...base.fabricator, completedAtMs: MS_PER_MINUTE },
    });

  it('is not running at all before the last print lands', () => {
    expect(endingStage(endgameState(), content)).toBe('none');
    expect(endingProgress(endgameState(), content)).toBe(0);
    expect(isEndingComplete(endgameState(), content)).toBe(false);
  });

  it('walks numbers → museum → credits → complete on the clock alone', () => {
    expect(endingStage(finishedAt(0), content)).toBe('numbers');
    expect(endingStage(finishedAt(numbersDesignSeconds), content)).toBe('museum');
    expect(endingStage(finishedAt(numbersDesignSeconds + museumDesignSeconds), content)).toBe(
      'credits',
    );
    const total = endingTotalMs(content) / MS_PER_SECOND;
    expect(endingStage(finishedAt(total), content)).toBe('complete');
    expect(isEndingComplete(finishedAt(total), content)).toBe(true);
    expect(endingProgress(finishedAt(total), content)).toBe(1);
  });
});

describe('New Game Plus (spec §18 M6)', () => {
  const finished = (): GameState =>
    endgameState({
      simTimeMs: MS_PER_MINUTE + endingTotalMs(content),
      fabricator: { ...base.fabricator, sections: 3, completedAtMs: MS_PER_MINUTE },
      designs: { 'money-plate': { level: 4, printsOnLevel: 2 } },
      resources: { ...base.resources, parts: 999, plates: 12, designs: 1 },
      selfAssembling: true,
    });

  it('is only offered once the credits have finished printing', () => {
    expect(newGamePlusAvailability(endgameState(), content)).toBe('not-ready');
    expect(newGamePlusAvailability(finished(), content)).toBeNull();
  });

  it('keeps the Designs and starts everything else again', () => {
    const restarted = startNewGamePlus(finished(), content, []);
    expect(restarted.run).toBe(1);
    expect(restarted.state.designs).toEqual(finished().designs);
    expect(restarted.state.resources.designs).toBe(1);
    expect(restarted.state.phaseId).toBe(content.pacing.phases[0]?.id);
    expect(restarted.state.simTimeMs).toBe(0);
    expect(restarted.state.resources.parts).toBe(content.start.startingResources.parts);
    expect(restarted.state.upgrades).toEqual({});
    expect(restarted.state.forkId).toBeNull();
    expect(restarted.state.fabricator).toEqual(base.fabricator);
    // The workshop remembers how to build itself — that is a fact about the
    // player, not about the run (spec §6 phase 4).
    expect(restarted.state.selfAssembling).toBe(true);
  });

  it('carries only the modifiers content offers, and folds them into the run', () => {
    const modifier = content.endgame.newGamePlus.modifiers[0];
    if (modifier === undefined) {
      throw new Error('content must offer at least one New Game Plus modifier');
    }
    const restarted = startNewGamePlus(finished(), content, [modifier.id, 'no-such-modifier']);
    expect(restarted.modifierIds).toEqual([modifier.id]);
    expect(newGamePlusModifiers(content, restarted.modifierIds)).toEqual([modifier]);
    const modifiers = computeModifiers(restarted.state, content);
    const effect = modifier.effects[0];
    if (effect === undefined) {
      throw new Error('a modifier must do something');
    }
    expect(modifiers.get(effect.type)).toBe(effect.value);
  });
});
