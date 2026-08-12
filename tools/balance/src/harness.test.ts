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
import {
  buildBudgetTable,
  checkPhaseBudgets,
  gatedPhaseIds,
  isPlaceholderPhase,
} from './budget.js';
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
 * construction; the mechanics that make them real arrive in M5–M6. What this
 * gate genuinely measures today is the intro, the bench and the farm — which
 * is what M1–M4 built.
 */
/** Read from content, not listed here: see `isPlaceholderPhase`. */
const GATED_PHASES = gatedPhaseIds(content);

describe('CI balance gate: the balanced bot vs the spec §6 budgets', () => {
  const log = runHeadless({ content, bot: REFERENCE_BOT });

  it('finishes the whole arc', () => {
    expect(log.finalPhaseId).toBe('end');
  });

  it('lands every phase inside its ±20 % window', () => {
    expect(checkPhaseBudgets(table, log.phaseDurations)).toEqual([]);
  });

  it('keeps every wait wall in a phase with mechanics under budget (spec §12.2)', () => {
    const violations = checkWaitWalls(content, log.waitWalls).filter((violation) =>
      GATED_PHASES.includes(violation.phaseId),
    );
    expect(violations).toEqual([]);
  });

  /**
   * The other half of that gate, stated rather than hidden.
   *
   * Once the reference player has bought everything M4 sells, the placeholder
   * phases have nothing left to offer and the detector correctly reports dead
   * zones there. Raising those budgets would make the report green and the
   * game no better, so the overrun is asserted instead: when M5 gives the
   * studio real mechanics this test fails, which is exactly the reminder the
   * next milestone wants.
   */
  it('still reports the placeholder phases as dead zones until M5–M6 fill them', () => {
    const dead = new Set(
      checkWaitWalls(content, log.waitWalls).map((violation) => violation.phaseId),
    );
    expect([...dead].every((phaseId) => !GATED_PHASES.includes(phaseId))).toBe(true);
    expect(dead.has('studio')).toBe(true);
    // And the gated phases really are the ones with mechanics behind them.
    expect([...GATED_PHASES]).toEqual(['intro', 'bench', 'farm']);
  });

  it('keeps phases 0–2 — the ones the game actually gates — on budget', () => {
    for (const phaseId of GATED_PHASES) {
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
 *
 * M4 changed what separates them. In M3 `greedy-spender` stalled: printers were
 * cheap enough that it never saved for the SLA unit the farm gate needs. Bays
 * now cap the fleet (spec §4), so its buying reflex runs into a ceiling, it is
 * *forced* to buy a config slot, and it reaches the end — much faster and with
 * an order of magnitude more prints. That is a real finding about the economy,
 * and it is asserted here so a change that quietly erases the distinction is
 * noticed.
 */
describe('the strategies are genuinely different players', () => {
  const balanced = runHeadless({ content, bot: balancedBot });
  const greedy = runHeadless({ content, bot: greedySpenderBot });
  const idleHeavy = runHeadless({ content, bot: idleHeavyBot });

  it('the attentive players finish; the ten-minute check-in does not', () => {
    expect(balanced.finalPhaseId).toBe('end');
    expect(greedy.finalPhaseId).toBe('end');
    expect(idleHeavy.finalPhaseId).not.toBe('end');
  });

  it('greedy out-produces balanced and rushes the farm it was meant to dwell in', () => {
    expect(greedy.finalState.stats.printsCompleted).toBeGreaterThan(
      balanced.finalState.stats.printsCompleted,
    );
    expect(greedy.phaseDurations.get('farm') ?? 0).toBeLessThan(
      balanced.phaseDurations.get('farm') ?? 0,
    );
  });

  it('idle-heavy pays for its inattention in the intro alone', () => {
    // Seven clicks at one check-in every ten design-minutes.
    expect(idleHeavy.phaseDurations.get('intro') ?? 0).toBeGreaterThan(
      balanced.phaseDurations.get('intro') ?? 0,
    );
  });

  /**
   * The print rota is the mechanic for the player who is not watching, so the
   * player who is not watching is the one that exercises it (spec §19: a new
   * mechanic means bot support). `idle-heavy` buys the auto-changeover unit
   * ahead of the others and writes a rota onto its bay; the attentive bots
   * deliberately do not, because a bot that re-loads a slot the moment the
   * margin moves would only be paying for purges it did not need.
   */
  it('lets the ten-minute player put a bay on a rota', () => {
    expect(idleHeavy.eventCounts.SLOT_QUEUE_SET ?? 0).toBeGreaterThan(0);
    expect(balanced.eventCounts.SLOT_QUEUE_SET ?? 0).toBe(0);
  });

  /**
   * Both sides of the per-run fork (spec §5B) get played. `greedy-spender`
   * takes whichever branch multiplies output hardest and `balanced` keeps its
   * rack, so neither branch is dead content that only a unit test ever visits.
   */
  it('takes opposite sides of the Farm/Goliath fork', () => {
    const greedyFork = content.forks.find((def) => def.id === greedy.finalState.forkId);
    const balancedFork = content.forks.find((def) => def.id === balanced.finalState.forkId);
    expect(greedyFork?.visual).toBe('goliath');
    expect(balancedFork?.visual).toBe('rack');
    expect(greedy.finalState.slots).toHaveLength(2);
    expect(balanced.finalState.slots.length).toBeGreaterThan(1);
  });
});

/**
 * The M4 loop end to end (spec §19: a new mechanic means bot support). Every
 * assertion below is something the reference player *did*, through the same
 * reducer the app dispatches into.
 */
describe('the balanced bot plays the M4 loop end to end', () => {
  const log = runHeadless({ content, bot: REFERENCE_BOT });
  const state = log.finalState;

  it('outgrows its first bay and buys another (spec §4)', () => {
    expect(log.eventCounts.SLOT_UNLOCKED).toBeGreaterThan(0);
    expect(state.slots.length).toBeGreaterThan(1);
    expect(state.slots.length).toBeLessThanOrEqual(content.start.slotCount + content.slots.length);
  });

  it('spreads the fleet across the rack rather than piling it into one bay', () => {
    expect(log.eventCounts.PRINTERS_ASSIGNED).toBeGreaterThan(0);
    const staffed = state.slots.filter((slot) => slot.printerCount > 0);
    expect(staffed.length).toBeGreaterThan(1);
  });

  it('never fields more machines than its bays can hold', () => {
    const ceiling = content.start.printersPerSlot;
    for (const slot of state.slots) {
      expect(slot.printerCount, slot.id).toBeLessThanOrEqual(ceiling);
    }
    const assigned = state.slots.reduce((total, slot) => total + slot.printerCount, 0);
    const owned = Object.values(state.printers).reduce((total, count) => total + count, 0);
    expect(assigned).toBe(owned);
  });

  it('commits the run to one branch of the fork and never to both', () => {
    expect(log.eventCounts.FORK_CHOSEN).toBe(1);
    expect(state.forkId).not.toBeNull();
  });
});

describe('placeholder phases (spec §18)', () => {
  it('are recognised from their gate, not from a list of names', () => {
    const byId = new Map(content.pacing.phases.map((phase) => [phase.id, phase]));
    const intro = byId.get('intro');
    const studio = byId.get('studio');
    if (intro === undefined || studio === undefined) {
      throw new Error('expected the spec §6 phases');
    }
    expect(isPlaceholderPhase(intro)).toBe(false);
    expect(isPlaceholderPhase(studio)).toBe(true);
    // Give the studio one real requirement and it stops being a placeholder,
    // with no tool told anything — which is the point of deriving it.
    expect(
      isPlaceholderPhase({ ...studio, advanceWhen: [{ metric: 'designs', atLeast: 1 } as never] }),
    ).toBe(false);
  });
});
