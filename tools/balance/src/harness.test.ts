import { RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { REFERENCE_BOT, findBot, greedySpenderBot, idleBot } from './bots.js';
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
    const log = runHeadless({ content, bot: greedySpenderBot });
    expect(log.botId).toBe('greedy-spender');
    expect(log.ticks).toBeGreaterThan(0);
    expect(log.designMinutes).toBeGreaterThanOrEqual(table.totalDesignMinutes);
    expect(log.finalPhaseId).toBe('end');
  });

  it('keeps the reference bot inside every phase budget (CI gate)', () => {
    const log = runHeadless({ content, bot: REFERENCE_BOT });
    expect(checkPhaseBudgets(table, log.phaseDurations)).toEqual([]);
  });

  it('is deterministic for a given seed', () => {
    const a = runHeadless({ content, bot: greedySpenderBot, seed: 7 });
    const b = runHeadless({ content, bot: greedySpenderBot, seed: 7 });
    expect(b.phaseDurations).toEqual(a.phaseDurations);
    expect(b.ticks).toBe(a.ticks);
    expect(b.finalState).toEqual(a.finalState);
  });

  it('reaches identical phase ordering at any targetHours (pace invariance)', () => {
    const fastRaw = deepClone(RAW_CONTENT);
    (fastRaw.pacing as { targetHours: number }).targetHours = 4;
    const fast = loadContent(fastRaw);
    const slow = runHeadless({ content, bot: greedySpenderBot });
    const quick = runHeadless({ content: fast, bot: greedySpenderBot });
    expect([...quick.phaseEnteredAt.keys()]).toEqual([...slow.phaseEnteredAt.keys()]);
    expect(quick.designMinutes).toBeCloseTo(slow.designMinutes, 6);
    expect(quick.wallHours).toBeCloseTo(slow.wallHours / 2, 6);
  });

  it('records phases the FSM walks straight through in one tick', () => {
    // Two gates satisfied at once: the FSM advances twice inside a single tick.
    // A before/after comparison would drop the middle phase entirely and report
    // it as never-reached, so the timeline is built from PHASE_ADVANCED events.
    const raw = deepClone(RAW_CONTENT);
    const phases = (raw.pacing as { phases: { advanceWhen: unknown }[] }).phases;
    const trivial = [{ metric: 'totalDesignMinutes', atLeast: 0 }];
    const first = phases[0];
    const second = phases[1];
    if (first === undefined || second === undefined) {
      throw new Error('expected at least two phases');
    }
    first.advanceWhen = trivial;
    second.advanceWhen = trivial;

    const log = runHeadless({
      content: loadContent(raw),
      bot: idleBot,
      limitDesignMinutes: 30,
    });
    expect(log.phaseEnteredAt.has('intro')).toBe(true);
    expect(log.phaseEnteredAt.has('bench')).toBe(true);
    expect(log.phaseDurations.has('bench')).toBe(true);
    expect(log.finalPhaseId).toBe('farm');
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
    expect(findBot('greedy-spender')).toBe(greedySpenderBot);
    expect(() => findBot('nope')).toThrow(/unknown bot/);
  });
});

/**
 * The end-to-end proof M1 exists for: the loop the player will actually play,
 * driven by a bot through the real reducer, start to printer #2.
 */
describe('greedy-spender plays the M1 loop end to end', () => {
  const log = runHeadless({ content, bot: greedySpenderBot, stopAtPhaseId: 'farm' });
  const state = log.finalState;

  it('finishes the intro assembly by attaching every piece', () => {
    expect(log.actionsByType.ATTACH_PIECE).toBe(content.start.assemblyPieces.length);
    expect(state.assembly.attachedPieceIds).toHaveLength(content.start.assemblyPieces.length);
    expect(log.eventCounts.ASSEMBLY_COMPLETED).toBe(1);
  });

  it('prints, sells and restocks — the core loop turns', () => {
    expect(log.eventCounts.PRINT_COMPLETED).toBeGreaterThan(0);
    expect(log.eventCounts.PART_SOLD).toBeGreaterThan(0);
    expect(log.eventCounts.FILAMENT_PURCHASED).toBeGreaterThan(0);
    expect(state.stats.partsProduced).toBeGreaterThan(0);
    expect(state.stats.moneyEarned).toBeGreaterThan(0);
  });

  it('buys printer #2 and beyond off the cost curve', () => {
    expect(state.printers[content.start.printerId]).toBeGreaterThanOrEqual(4);
    // One built by hand in the intro, the rest paid for.
    const paid = (log.actionsByType.BUY_PRINTER ?? 0) > 0;
    expect(paid).toBe(true);
    expect(log.eventCounts.PRINTER_BUILT).toBeGreaterThanOrEqual(4);
  });

  it('leaves intro and bench on budget and enters farm', () => {
    expect(log.finalPhaseId).toBe('farm');
    expect(checkPhaseBudgets(table, log.phaseDurations).map((v) => v.phaseId)).toEqual([
      // Only phases the run stopped short of are unreached; intro/bench are on budget.
      'farm',
      'studio',
      'prestige',
      'absurd',
      'end',
    ]);
  });

  it('records resource curves and per-phase decision counts', () => {
    expect(log.samples.length).toBeGreaterThan(1);
    expect(log.samples[0]?.designMinutes).toBe(0);
    expect(log.samples.at(-1)?.printers).toBeGreaterThanOrEqual(4);
    expect(log.decisionsByPhase.get('intro')).toBeGreaterThan(0);
    expect(log.decisionsByPhase.get('bench')).toBeGreaterThan(0);
    expect(log.decisions).toBe(
      [...log.decisionsByPhase.values()].reduce((total, count) => total + count, 0),
    );
  });

  it('never drives a resource negative', () => {
    for (const sample of log.samples) {
      expect(sample.parts).toBeGreaterThanOrEqual(0);
      expect(sample.money).toBeGreaterThanOrEqual(0);
      expect(sample.filamentGrams).toBeGreaterThanOrEqual(0);
    }
  });
});
