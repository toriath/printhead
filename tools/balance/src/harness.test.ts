import { RAW_CONTENT, loadContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  BOTS,
  REFERENCE_BOT,
  balancedBot,
  findBot,
  greedySpenderBot,
  idleBot,
  idleHeavyBot,
} from './bots.js';
import { buildBudgetTable, checkPhaseBudgets } from './budget.js';
import { runHeadless } from './harness.js';
import { checkWaitWalls } from './waitwall.js';

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

describe('the bot roster', () => {
  it('ships the spec §12.1 trio plus the idle floor', () => {
    expect(BOTS.map((bot) => bot.id)).toEqual(['idle', 'greedy-spender', 'balanced', 'idle-heavy']);
    expect(REFERENCE_BOT).toBe(balancedBot);
  });

  it('resolves bots by id', () => {
    expect(findBot('idle')).toBe(idleBot);
    expect(findBot('balanced')).toBe(balancedBot);
    expect(findBot('idle-heavy')).toBe(idleHeavyBot);
    expect(() => findBot('nope')).toThrow(/unknown bot/);
  });

  it('checks in rarely when it is meant to be idle-heavy (spec §12.1)', () => {
    expect(idleHeavyBot.checkInDesignSeconds).toBeGreaterThanOrEqual(600);
    expect(balancedBot.checkInDesignSeconds).toBeLessThan(60);
  });
});

describe('headless harness', () => {
  it('runs the real core and logs the run', () => {
    const log = runHeadless({ content, bot: balancedBot });
    expect(log.botId).toBe('balanced');
    expect(log.ticks).toBeGreaterThan(0);
    expect(log.designMinutes).toBeGreaterThanOrEqual(table.totalDesignMinutes);
    expect(log.finalPhaseId).toBe('end');
  });

  it('is deterministic for a given seed', () => {
    const a = runHeadless({ content, bot: balancedBot, seed: 7 });
    const b = runHeadless({ content, bot: balancedBot, seed: 7 });
    expect(b.phaseDurations).toEqual(a.phaseDurations);
    expect(b.ticks).toBe(a.ticks);
    expect(b.finalState).toEqual(a.finalState);
  });

  it('reaches identical phase ordering at any targetHours (pace invariance)', () => {
    const fastRaw = deepClone(RAW_CONTENT);
    (fastRaw.pacing as { targetHours: number }).targetHours = 4;
    const fast = loadContent(fastRaw);
    const slow = runHeadless({ content, bot: balancedBot });
    const quick = runHeadless({ content: fast, bot: balancedBot });
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
});

/**
 * The CI balance gate (spec §12.6). A balance regression fails exactly like a
 * failing unit test: the reference bot must finish every phase inside its
 * window, and no wait wall may overrun the budget its phase declares.
 *
 * Phases 3–6 are still time-gated placeholders, so they are on budget by
 * construction; the mechanics that make them real arrive in M4–M6. What this
 * gate genuinely measures today is the intro, the bench and the farm — which
 * is exactly what M3 built.
 */
describe('CI balance gate: the balanced bot vs the spec §6 budgets', () => {
  const log = runHeadless({ content, bot: REFERENCE_BOT });

  it('finishes the whole arc', () => {
    expect(log.finalPhaseId).toBe('end');
  });

  it('lands every phase inside its ±20 % window', () => {
    expect(checkPhaseBudgets(table, log.phaseDurations)).toEqual([]);
  });

  it('keeps every wait wall under its phase budget (spec §12.2)', () => {
    expect(checkWaitWalls(content, log.waitWalls)).toEqual([]);
  });

  it('keeps phases 0–2 — the ones M3 actually gates — on budget', () => {
    for (const phaseId of ['intro', 'bench', 'farm']) {
      const phase = table.phases.find((candidate) => candidate.phaseId === phaseId);
      const actual = log.phaseDurations.get(phaseId);
      expect(actual, phaseId).toBeDefined();
      expect(actual, phaseId).toBeGreaterThanOrEqual(phase?.minDesignMinutes ?? 0);
      expect(actual, phaseId).toBeLessThanOrEqual(phase?.maxDesignMinutes ?? 0);
    }
  });
});

/**
 * The end-to-end proof the milestone exists for: the M3 loop — print, fail,
 * recycle, upgrade, automate, trade — driven by a bot through the real reducer.
 */
describe('the balanced bot plays the M3 loop end to end', () => {
  const log = runHeadless({ content, bot: balancedBot, stopAtPhaseId: 'studio' });
  const state = log.finalState;

  it('finishes the intro assembly by attaching every piece', () => {
    expect(log.actionsByType.ATTACH_PIECE).toBe(content.start.assemblyPieces.length);
    expect(log.eventCounts.ASSEMBLY_COMPLETED).toBe(1);
  });

  it('prints, fails, and turns the wreckage back into filament', () => {
    expect(state.stats.printsCompleted).toBeGreaterThan(0);
    expect(state.stats.printsFailed).toBeGreaterThan(0);
    expect(state.stats.scrapProducedGrams).toBeGreaterThan(0);
    expect(state.stats.scrapRecycledGrams).toBeGreaterThan(0);
    expect(log.eventCounts.SCRAP_RECYCLED).toBeGreaterThan(0);
  });

  it('climbs the machine tree and unlocks a gated material', () => {
    expect(state.upgrades['heated-bed']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(state.upgrades).length).toBeGreaterThanOrEqual(2);
    expect(log.eventCounts.UPGRADE_INSTALLED).toBeGreaterThan(0);
  });

  it('buys its way out of the friction it was sold (spec §5C)', () => {
    expect(log.eventCounts.AUTOMATION_INSTALLED).toBeGreaterThanOrEqual(2);
    expect(log.eventCounts.AUTOMATION_FIRED).toBeGreaterThan(0);
  });

  it('trades on the market rather than at a fixed shelf price', () => {
    expect(log.eventCounts.FILAMENT_PURCHASED).toBeGreaterThan(0);
    expect(state.stats.filamentPurchasedGrams).toBeGreaterThan(0);
  });

  it('records resource curves, wait walls and per-phase decision counts', () => {
    expect(log.samples.length).toBeGreaterThan(1);
    expect(log.samples[0]?.designMinutes).toBe(0);
    expect(log.decisionsByPhase.get('intro')).toBeGreaterThan(0);
    expect(log.decisionsByPhase.get('bench')).toBeGreaterThan(0);
    expect(log.decisions).toBe(
      [...log.decisionsByPhase.values()].reduce((total, count) => total + count, 0),
    );
    expect(log.waitWalls.length).toBeGreaterThan(0);
  });

  it('never drives a resource negative', () => {
    for (const sample of log.samples) {
      expect(sample.parts).toBeGreaterThanOrEqual(0);
      expect(sample.money).toBeGreaterThanOrEqual(0);
      expect(sample.filamentGrams).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * The three strategies must actually differ, or the roster is decoration.
 * `greedy-spender` buying capacity the moment it can afford it is a *trap* in
 * M3 content: printers stay cheap enough that it never saves for the SLA unit
 * the farm gate needs, so it stalls where the balanced player moves on. That is
 * a real finding about the economy, and it is asserted here so a future change
 * that quietly erases the distinction is noticed.
 */
describe('the strategies are genuinely different players', () => {
  const balanced = runHeadless({ content, bot: balancedBot });
  const greedy = runHeadless({ content, bot: greedySpenderBot });
  const idleHeavy = runHeadless({ content, bot: idleHeavyBot });

  it('the balanced player is the only one that finishes', () => {
    expect(balanced.finalPhaseId).toBe('end');
    expect(greedy.finalPhaseId).not.toBe('end');
    expect(idleHeavy.finalPhaseId).not.toBe('end');
  });

  it('greedy out-produces balanced and still gets stuck', () => {
    expect(greedy.finalState.stats.printsCompleted).toBeGreaterThan(
      balanced.finalState.stats.printsCompleted,
    );
    expect(greedy.finalState.printers['bench-mk1'] ?? 0).toBeGreaterThan(
      balanced.finalState.printers['bench-mk1'] ?? 0,
    );
  });

  it('idle-heavy pays for its inattention in the intro alone', () => {
    // Seven clicks at one check-in every ten design-minutes.
    expect(idleHeavy.phaseDurations.get('intro') ?? 0).toBeGreaterThan(
      balanced.phaseDurations.get('intro') ?? 0,
    );
  });
});
