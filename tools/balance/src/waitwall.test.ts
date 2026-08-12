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
    expect(meaningfulOptions(base, content, curves)).toEqual([]);
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
          printerCount: 1,
          autoRestart: false,
          run: null,
          failureCharge: 0,
          changeoverMs: 0,
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
          printerCount: 1,
          autoRestart: false,
          run: null,
          failureCharge: 0,
          changeoverMs: 5000,
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
