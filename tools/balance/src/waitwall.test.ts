import {
  type Content,
  type GameState,
  RAW_CONTENT,
  createCurveRegistry,
  createInitialState,
  loadContent,
} from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  WaitWallTracker,
  checkWaitWalls,
  longestWallByPhase,
  meaningfulOptions,
} from './waitwall.js';

const content = loadContent(RAW_CONTENT);
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });

const at = (phaseId: string, over: Partial<GameState> = {}): GameState => ({
  ...base,
  phaseId,
  ...over,
});

describe('meaningfulOptions', () => {
  it('counts the very first click of the game', () => {
    const ready = at('intro', { assembly: { attachedPieceIds: [], cooldownMs: 0 } });
    expect(meaningfulOptions(ready, content, curves)).toContain('attach-piece');
  });

  it('is empty while the bench work for the next piece is still running', () => {
    const baking = { ...base, assembly: { ...base.assembly, cooldownMs: 30_000 } };
    expect(meaningfulOptions(baking, content, curves)).toEqual([]);
  });

  it('spots an affordable machine, upgrade and automation', () => {
    const rich = at('bench', {
      resources: { ...base.resources, parts: 100_000, money: 100_000 },
      partsValue: 100_000,
    });
    const options = meaningfulOptions(rich, content, curves);
    expect(options).toContain('buy-printer');
    expect(options).toContain('buy-upgrade');
    expect(options).toContain('buy-automation');
  });

  it('does not count a purchase the phase has not unlocked', () => {
    const rich = at('intro', {
      resources: { ...base.resources, parts: 100_000 },
      partsValue: 100_000,
    });
    expect(meaningfulOptions(rich, content, curves)).not.toContain('buy-printer');
  });

  it('does not count selling parts — that is a step, not a decision', () => {
    const holding = at('bench', {
      resources: { ...base.resources, parts: 1 },
      partsValue: 1,
      assembly: { attachedPieceIds: [], cooldownMs: 1000 },
    });
    expect(meaningfulOptions(holding, content, curves)).toEqual([]);
  });

  it('counts a full scrap bin once the recycler is installed', () => {
    const recyclerId = content.failure.recycler.requiresUpgradeId;
    const scrapped = at('bench', { resources: { ...base.resources, scrap: 10 }, scrapValue: 1 });
    expect(meaningfulOptions(scrapped, content, curves)).not.toContain('recycle-scrap');
    expect(
      meaningfulOptions({ ...scrapped, upgrades: { [recyclerId]: 1 } }, content, curves),
    ).toContain('recycle-scrap');
  });

  it('counts an idle machine you can feed, and a restock that would unstick it', () => {
    const loaded = at('bench', {
      printers: { 'bench-mk1': 1 },
      filamentGrams: { pla: 100 },
      slots: [
        {
          id: 'slot-1',
          materialId: 'pla',
          objectId: 'bracket',
          designId: null,
          printerCount: 1,
          autoRestart: false,
          run: null,
          failureCharge: 0,
          changeoverMs: 0,
          queue: [],
          queueIndex: 0,
          queueBatches: 0,
          perfectCharge: 0,
          overclockMs: 0,
          overclockCooldownMs: 0,
        },
      ],
    });
    expect(meaningfulOptions(loaded, content, curves)).toContain('feed-idle-slot');

    const dry = {
      ...loaded,
      filamentGrams: { pla: 0 },
      resources: { ...base.resources, money: 50 },
    };
    const options = meaningfulOptions(dry, content, curves);
    expect(options).toContain('restock-filament');
    expect(options).not.toContain('feed-idle-slot');
  });

  it('is empty for a slot that is mid-purge with an empty till', () => {
    const purging = at('bench', {
      printers: { 'bench-mk1': 1 },
      filamentGrams: { pla: 100 },
      slots: [
        {
          id: 'slot-1',
          materialId: 'pla',
          objectId: 'bracket',
          designId: null,
          printerCount: 1,
          autoRestart: false,
          run: null,
          failureCharge: 0,
          changeoverMs: 5000,
          queue: [],
          queueIndex: 0,
          queueBatches: 0,
          perfectCharge: 0,
          overclockMs: 0,
          overclockCooldownMs: 0,
        },
      ],
    });
    expect(meaningfulOptions(purging, content, curves)).toEqual([]);
  });
});

describe('WaitWallTracker', () => {
  it('finds nothing when there is always something to do', () => {
    const tracker = new WaitWallTracker();
    for (let minute = 0; minute < 10; minute += 1) {
      tracker.sample(minute, 'bench', true);
    }
    expect(tracker.finish()).toEqual([]);
  });

  it('measures a stretch from its first idle sample to the next busy one', () => {
    const tracker = new WaitWallTracker();
    tracker.sample(0, 'bench', true);
    tracker.sample(1, 'bench', false);
    tracker.sample(2, 'bench', false);
    tracker.sample(5, 'bench', true);
    expect(tracker.finish()).toEqual([
      { phaseId: 'bench', startDesignMinutes: 1, endDesignMinutes: 5, durationDesignMinutes: 4 },
    ]);
  });

  it('closes an open stretch when the run stops', () => {
    const tracker = new WaitWallTracker();
    tracker.sample(1, 'bench', false);
    tracker.sample(9, 'bench', false);
    expect(tracker.finish()).toEqual([
      { phaseId: 'bench', startDesignMinutes: 1, endDesignMinutes: 9, durationDesignMinutes: 8 },
    ]);
  });

  /**
   * The bug this test pins: charging a boundary-crossing stretch entirely to
   * the phase it began in reported a 9.6-minute wall inside a 5-minute intro.
   */
  it('splits a stretch that runs across a phase boundary', () => {
    const tracker = new WaitWallTracker();
    tracker.sample(1, 'intro', false);
    tracker.sample(4, 'intro', false);
    tracker.sample(5, 'bench', false);
    tracker.sample(12, 'bench', true);
    expect(tracker.finish()).toEqual([
      { phaseId: 'intro', startDesignMinutes: 1, endDesignMinutes: 5, durationDesignMinutes: 4 },
      { phaseId: 'bench', startDesignMinutes: 5, endDesignMinutes: 12, durationDesignMinutes: 7 },
    ]);
  });

  it('records several separate stretches', () => {
    const tracker = new WaitWallTracker();
    tracker.sample(0, 'bench', false);
    tracker.sample(2, 'bench', true);
    tracker.sample(3, 'bench', false);
    tracker.sample(6, 'bench', true);
    expect(tracker.finish().map((wall) => wall.durationDesignMinutes)).toEqual([2, 3]);
  });
});

describe('checkWaitWalls', () => {
  it('flags only the stretches that overrun their phase budget', () => {
    const walls = [
      { phaseId: 'bench', startDesignMinutes: 1, endDesignMinutes: 2, durationDesignMinutes: 1 },
      { phaseId: 'bench', startDesignMinutes: 4, endDesignMinutes: 40, durationDesignMinutes: 36 },
    ];
    const violations = checkWaitWalls(content, walls);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.durationDesignMinutes).toBe(36);
  });

  it('ignores a wall in a phase that does not exist', () => {
    expect(
      checkWaitWalls(content, [
        {
          phaseId: 'ghost',
          startDesignMinutes: 0,
          endDesignMinutes: 99,
          durationDesignMinutes: 99,
        },
      ]),
    ).toEqual([]);
  });

  it('honours a budget of zero as "no dead time at all"', () => {
    const strict: Content = {
      ...content,
      pacing: {
        ...content.pacing,
        phases: content.pacing.phases.map((phase) => ({
          ...phase,
          waitWallBudgetDesignMinutes: 0,
        })),
      },
    };
    expect(
      checkWaitWalls(strict, [
        {
          phaseId: 'bench',
          startDesignMinutes: 0,
          endDesignMinutes: 0.1,
          durationDesignMinutes: 0.1,
        },
      ]),
    ).toHaveLength(1);
  });
});

describe('longestWallByPhase', () => {
  it('keeps only the worst stretch per phase', () => {
    const worst = longestWallByPhase([
      { phaseId: 'bench', startDesignMinutes: 0, endDesignMinutes: 2, durationDesignMinutes: 2 },
      { phaseId: 'bench', startDesignMinutes: 4, endDesignMinutes: 9, durationDesignMinutes: 5 },
      { phaseId: 'farm', startDesignMinutes: 9, endDesignMinutes: 10, durationDesignMinutes: 1 },
    ]);
    expect([...worst]).toEqual([
      ['bench', 5],
      ['farm', 1],
    ]);
  });
});

/**
 * The meta layer's options (spec §5D/§5E). Each of these is a real decision a
 * player could take, and the detector's whole value is that it counts only
 * decisions the reducer would actually accept — a button that refuses is a dead
 * zone with extra steps.
 */
describe('meaningfulOptions and the meta layer', () => {
  const capstoneId = content.prestige.requiredDesignId;
  const capstone = content.designs.find((def) => def.id === capstoneId);
  const pressId = content.prestige.moneyPrinters[0]?.id ?? 'bill-printer';

  const studio = (over: Partial<GameState> = {}): GameState => ({
    ...base,
    phaseId: 'studio',
    printers: { 'bench-mk1': 1 },
    upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
    resources: { ...base.resources, money: 1_000_000 },
    slots: [
      {
        id: 'slot-1',
        materialId: 'pla',
        objectId: 'bracket',
        designId: null,
        printerCount: 1,
        autoRestart: false,
        run: null,
        failureCharge: 0,
        changeoverMs: 0,
        queue: [],
        queueIndex: 0,
        queueBatches: 0,
        perfectCharge: 0,
        overclockMs: 0,
        overclockCooldownMs: 0,
      },
    ],
    ...over,
  });

  it('offers a commission the studio would take, and none it would not', () => {
    expect(meaningfulOptions(studio(), content, curves)).toContain('draft-design');
    expect(meaningfulOptions(studio({ upgrades: {} }), content, curves)).not.toContain(
      'draft-design',
    );
    expect(
      meaningfulOptions(studio({ resources: { ...base.resources, money: 0 } }), content, curves),
    ).not.toContain('draft-design');
  });

  it('offers a bay for a Design only while its material is open (spec §3)', () => {
    const owned = { [capstoneId]: { level: 1, printsOnLevel: 0 } };
    expect(meaningfulOptions(studio({ designs: owned }), content, curves)).toContain('load-design');
    // The melt-down takes the SLA unit with everything else, so the Design is
    // still owned and still unprintable — which is not a decision.
    expect(
      meaningfulOptions(studio({ designs: owned, upgrades: {} }), content, curves),
    ).not.toContain('load-design');
    expect(capstone?.requiredMaterialId).toBe('resin');
  });

  /**
   * The endgame (spec §5E, §6 phase 6). A player with Plates in hand and a tree
   * to spend them on is not idle, and neither is one who could pre-print a
   * section or start the last print — but the detector must say so only where
   * the phase FSM actually allows it.
   */
  it('offers the endgame tree, a section and the last print where they are live', () => {
    const fabricator = content.endgame.fabricator;
    const endgame = studio({
      phaseId: 'end',
      forkId: 'goliath',
      printers: { 'bench-mk1': fabricator.requiredPrinters },
      upgrades: {
        'heated-bed': 1,
        enclosure: 1,
        'sla-unit': 1,
        'exotic-feedstock': 1,
        'print-a-building': 1,
        'print-a-factory': 1,
        'universal-fabricator': 1,
      },
      resources: { ...base.resources, money: 1_000, parts: 100_000, plates: 400 },
      partsValue: 100_000,
      filamentGrams: { ...base.filamentGrams, composite: fabricator.filamentGrams * 2 },
      slots: [
        {
          id: 'slot-1',
          materialId: 'pla',
          objectId: 'bracket',
          designId: null,
          printerCount: fabricator.requiredPrinters,
          autoRestart: false,
          run: null,
          failureCharge: 0,
          changeoverMs: 0,
          queue: [],
          queueIndex: 0,
          queueBatches: 0,
          perfectCharge: 0,
          overclockMs: 0,
          overclockCooldownMs: 0,
        },
      ],
    });
    const options = meaningfulOptions(endgame, content, curves);
    expect(options).toContain('print-section');
    expect(options).toContain('start-fabricator');
    // The factory has three levels, so there is still a node to climb.
    expect(options).toContain('buy-endgame-node');
    // With the Plate tin empty there is nothing in the tree to reach for.
    expect(
      meaningfulOptions(
        { ...endgame, resources: { ...endgame.resources, plates: 0 } },
        content,
        curves,
      ),
    ).not.toContain('buy-endgame-node');
    // ...and none of it is on offer a phase earlier, whatever is in the tin.
    const earlier = meaningfulOptions({ ...endgame, phaseId: 'studio' }, content, curves);
    expect(earlier).not.toContain('print-section');
    expect(earlier).not.toContain('start-fabricator');
  });

  it('offers a new run once the credits have finished (spec §18 M6)', () => {
    const finished = studio({
      phaseId: 'ended',
      simTimeMs: 10 * 60 * 1000,
      fabricator: { sections: 0, sectionRun: null, run: null, completedAtMs: 0 },
    });
    expect(meaningfulOptions(finished, content, curves)).toContain('new-game-plus');
    expect(meaningfulOptions({ ...finished, phaseId: 'end' }, content, curves)).not.toContain(
      'new-game-plus',
    );
  });

  it('offers the melt-down and the presses only where they are live', () => {
    const meltable = studio({
      phaseId: content.prestige.unlockPhaseId,
      designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } },
      resources: { ...base.resources, money: 4_000_000, plates: 500 },
    });
    const options = meaningfulOptions(meltable, content, curves);
    expect(options).toContain('prestige');
    expect(options).toContain('buy-money-printer');

    // In the studio phase neither action is allowed at all.
    expect(meaningfulOptions(studio(), content, curves)).not.toContain('prestige');
    expect(meaningfulOptions(studio(), content, curves)).not.toContain('buy-money-printer');
    // ...and with no Plates the press is not on offer either.
    expect(
      meaningfulOptions(
        { ...meltable, resources: { ...meltable.resources, plates: 0 } },
        content,
        curves,
      ),
    ).not.toContain('buy-money-printer');
    expect(pressId).toBe('bill-printer');
  });
});
