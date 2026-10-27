import { type DomainEvent, RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  buildOrder,
  choreShare,
  deadContent,
  longestDroughtByPhase,
  noveltyMoments,
  orderDivergence,
  topChore,
} from './fun.js';
import type { RunLog } from './harness.js';

const MINUTE = 60_000;
const content = loadContent(RAW_CONTENT);

/** Only the fields the fun signals read; everything else is irrelevant here. */
function logOf(over: Partial<RunLog>): RunLog {
  return {
    botId: 'test',
    events: [],
    actionsByType: {},
    phaseEnteredAt: new Map(),
    phaseDurations: new Map(),
    ...over,
  } as unknown as RunLog;
}

const upgrade = (minute: number, upgradeId: string): DomainEvent =>
  ({
    type: 'UPGRADE_INSTALLED',
    simTimeMs: minute * MINUTE,
    upgradeId,
    level: 1,
    paid: 1,
  }) as DomainEvent;

describe('noveltyMoments', () => {
  it('keeps the first of each thing and drops repeats', () => {
    const log = logOf({
      events: [upgrade(2, 'heated-bed'), upgrade(5, 'heated-bed'), upgrade(9, 'enclosure')],
    });
    expect(noveltyMoments(log).map((moment) => moment.designMinutes)).toEqual([2, 9]);
  });
});

describe('longestDroughtByPhase', () => {
  it('measures the longest gap between firsts, counting entry and exit', () => {
    const log = logOf({
      events: [upgrade(12, 'heated-bed'), upgrade(15, 'enclosure')],
      phaseEnteredAt: new Map([['bench', 10]]),
      phaseDurations: new Map([['bench', 30]]),
    });
    // 10 → 12 → 15 → 40: the last stretch, 25 minutes, is the drought.
    expect(longestDroughtByPhase(log).get('bench')).toBe(25);
  });

  it('reports the whole phase when nothing new ever happens in it', () => {
    const log = logOf({
      phaseEnteredAt: new Map([['farm', 0]]),
      phaseDurations: new Map([['farm', 80]]),
    });
    expect(longestDroughtByPhase(log).get('farm')).toBe(80);
  });
});

describe('chores', () => {
  const log = logOf({ actionsByType: { RECYCLE_SCRAP: 6, SELL_PARTS: 2, BUY_UPGRADE: 2 } });

  it('is the share of upkeep among all actions', () => {
    expect(choreShare(log)).toBeCloseTo(0.8, 9);
    expect(choreShare(logOf({}))).toBe(0);
  });

  it('names the most repeated chore', () => {
    expect(topChore(log)).toEqual({ type: 'RECYCLE_SCRAP', count: 6 });
  });
});

describe('deadContent', () => {
  it('lists every purchasable id no run acquired', () => {
    const dead = deadContent([logOf({ events: [upgrade(1, 'heated-bed')] })], content);
    expect(dead).not.toContain('heated-bed');
    expect(dead).toContain('enclosure');
    expect(dead).toContain('goliath');
  });

  it('does not count what was only bought after the game ended', () => {
    const log = logOf({
      events: [upgrade(1, 'heated-bed'), upgrade(500, 'enclosure')],
      phaseEnteredAt: new Map([['ended', 400]]),
    });
    const dead = deadContent([log], content);
    expect(dead).not.toContain('heated-bed');
    expect(dead).toContain('enclosure');
  });
});

describe('orderDivergence', () => {
  it('is 0 for the same order and 1 for the reverse', () => {
    expect(orderDivergence(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(0);
    expect(orderDivergence(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(1);
  });

  it('only compares what both runs bought', () => {
    expect(orderDivergence(['a', 'x', 'b'], ['b', 'a', 'y'])).toBe(1);
    expect(orderDivergence(['a'], ['b'])).toBe(0);
  });

  it('reads build orders without phases or first prints', () => {
    const log = logOf({
      events: [
        upgrade(1, 'heated-bed'),
        {
          type: 'PHASE_ADVANCED',
          simTimeMs: 2 * MINUTE,
          fromPhaseId: 'intro',
          toPhaseId: 'bench',
        } as DomainEvent,
      ],
    });
    expect(buildOrder(log)).toEqual(['upgrade heated-bed']);
  });
});
