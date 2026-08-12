import { RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { budgetPacedBot, findBot, idleBot } from './bots.js';
import { buildBudgetTable, checkPhaseBudgets } from './budget.js';
import { runHeadless } from './harness.js';

const content = loadContent(RAW_CONTENT);
const table = buildBudgetTable(content.pacing);
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('budget table', () => {
  it('mirrors the spec §6 budgets with a ±20 % window', () => {
    expect(table.tolerance).toBe(0.2);
    expect(table.totalDesignMinutes).toBe(420);
    const intro = table.phases[0];
    expect(intro?.budgetDesignMinutes).toBe(5);
    expect(intro?.minDesignMinutes).toBeCloseTo(4, 9);
    expect(intro?.maxDesignMinutes).toBeCloseTo(6, 9);
  });

  it('flags phases that are too fast, too slow or never reached', () => {
    const durations = new Map<string, number>([
      ['intro', 5],
      ['bench', 1],
      ['farm', 400],
      ['studio', 75],
      ['prestige', 90],
      ['absurd', 80],
    ]);
    const violations = checkPhaseBudgets(table, durations);
    expect(violations.map((violation) => [violation.phaseId, violation.reason])).toEqual([
      ['bench', 'too-fast'],
      ['farm', 'too-slow'],
      ['end', 'never-reached'],
    ]);
  });
});

describe('headless harness', () => {
  it('runs the real core and logs the run', () => {
    const log = runHeadless({ content, bot: budgetPacedBot });
    expect(log.botId).toBe('budget-paced');
    expect(log.ticks).toBeGreaterThan(0);
    expect(log.designMinutes).toBeGreaterThanOrEqual(table.totalDesignMinutes);
    expect(log.finalPhaseId).toBe('end');
  });

  it('keeps the reference bot inside every phase budget (CI gate)', () => {
    const log = runHeadless({ content, bot: budgetPacedBot });
    expect(checkPhaseBudgets(table, log.phaseDurations)).toEqual([]);
  });

  it('is deterministic for a given seed', () => {
    const a = runHeadless({ content, bot: budgetPacedBot, seed: 7 });
    const b = runHeadless({ content, bot: budgetPacedBot, seed: 7 });
    expect(b.phaseDurations).toEqual(a.phaseDurations);
    expect(b.ticks).toBe(a.ticks);
  });

  it('reaches identical phase ordering at any targetHours (pace invariance)', () => {
    const fastRaw = deepClone(RAW_CONTENT);
    (fastRaw.pacing as { targetHours: number }).targetHours = 4;
    const fast = loadContent(fastRaw);
    const slow = runHeadless({ content, bot: budgetPacedBot });
    const quick = runHeadless({ content: fast, bot: budgetPacedBot });
    expect([...quick.phaseEnteredAt.keys()]).toEqual([...slow.phaseEnteredAt.keys()]);
    expect(quick.designMinutes).toBeCloseTo(slow.designMinutes, 6);
    expect(quick.wallHours).toBeCloseTo(slow.wallHours / 2, 6);
  });

  it('an idle bot never leaves the first phase', () => {
    const log = runHeadless({ content, bot: idleBot, limitDesignMinutes: 60 });
    expect(log.finalPhaseId).toBe('intro');
    expect(log.actions).toBe(0);
  });

  it('rejects bots that check in faster than the tick rate', () => {
    expect(() =>
      runHeadless({
        content,
        bot: { id: 'twitchy', checkInDesignSeconds: 0.01, decide: () => [] },
      }),
    ).toThrow(/twitchy/);
  });

  it('resolves bots by id', () => {
    expect(findBot('idle')).toBe(idleBot);
    expect(() => findBot('nope')).toThrow(/unknown bot/);
  });
});
