import {
  RAW_CONTENT,
  createCurveRegistry,
  inflationMultiplier,
  loadContent,
} from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  BOTS,
  REFERENCE_BOT,
  balancedBot,
  createPolicyBot,
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
  placeholderPhaseIds,
} from './budget.js';
import { runHeadless } from './harness.js';
import { checkWaitWalls } from './waitwall.js';

const content = loadContent(RAW_CONTENT);
const table = buildBudgetTable(content.pacing);
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('budget table', () => {
  it('mirrors the spec §6 budgets with a ±20 % window', () => {
    expect(table.tolerance).toBe(0.2);
    // The arc's budget. The terminal `ended` sandbox is outside it: nothing
    // ends that phase, so it has no duration to budget (see `terminalPhaseId`).
    expect(table.totalDesignMinutes).toBe(420);
    expect(table.terminalPhaseId).toBe('ended');
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
      ['ended', 999],
    ]);
    const violations = checkPhaseBudgets(table, durations);
    expect(violations.map((violation) => [violation.phaseId, violation.reason])).toEqual([
      ['bench', 'too-fast'],
      ['farm', 'too-slow'],
      ['end', 'never-reached'],
    ]);
  });

  /**
   * The sandbox is judged on being *reached*, not on how long the player stays
   * — but it is still judged. A run that never finishes the game must fail.
   */
  it('asks the terminal sandbox only to be reached', () => {
    const reached = new Map(
      table.phases.map((phase) => [phase.phaseId, phase.budgetDesignMinutes]),
    );
    reached.set('ended', 10_000);
    expect(checkPhaseBudgets(table, reached)).toEqual([]);
    reached.delete('ended');
    expect(checkPhaseBudgets(table, reached).map((violation) => violation.phaseId)).toEqual([
      'ended',
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
    expect(log.finalPhaseId).toBe('ended');
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

  it('finishes the whole game — every phase, through to the post-game', () => {
    expect(log.finalPhaseId).toBe('ended');
    expect(log.eventCounts.FABRICATOR_COMPLETED).toBe(1);
    expect(log.eventCounts.GAME_ENDED).toBe(1);
  });

  /**
   * Spec §12.6 and the M6 brief: the whole arc inside ±20 % of the eight-hour
   * budget, measured in design time at `targetHours = 8`. The arc ends when the
   * FSM reaches the sandbox, not when the harness runs out of patience.
   */
  it('lands the whole arc inside ±20 % of the total budget', () => {
    const arc = log.phaseEnteredAt.get('ended');
    expect(arc).toBeDefined();
    expect(arc ?? 0).toBeGreaterThanOrEqual(table.totalDesignMinutes * (1 - table.tolerance));
    expect(arc ?? 0).toBeLessThanOrEqual(table.totalDesignMinutes * (1 + table.tolerance));
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
   * At M4 this test asserted the *opposite*: once the reference player had
   * bought everything the game sold, the placeholder phases had nothing left to
   * offer and the detector correctly reported dead zones in them. The meta
   * layer closed those — a melt-down to take, a press to install, a commission
   * to put on the bench are meaningful actions wherever the player is — so the
   * whole timeline is now live and the assertion is inverted rather than
   * deleted.
   *
   * What is *still* a placeholder is the gate: `absurd` and `end` advance on
   * elapsed design minutes alone, so they sit on budget by construction and M6
   * is what makes their green light mean anything.
   */
  it('leaves no dead zone anywhere, and has no placeholder gates left', () => {
    expect(checkWaitWalls(content, log.waitWalls)).toEqual([]);
    // Every phase of the arc now gates on something the player *did*. M5 moved
    // `studio` and `prestige` across this line; M6 moved the last two, which
    // is what makes the green light on phases 5–6 mean anything at all.
    expect([...GATED_PHASES]).toEqual([
      'intro',
      'bench',
      'farm',
      'studio',
      'prestige',
      'absurd',
      'end',
      'ended',
    ]);
    expect(placeholderPhaseIds(content)).toEqual([]);
  });

  it('keeps every gated phase of the arc on budget', () => {
    for (const phaseId of GATED_PHASES.filter((id) => id !== table.terminalPhaseId)) {
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
  // Anything a melt-down resets — the fork, the rack, the production counters —
  // has to be read before one happens (spec §5D).
  const balancedRunOne = runHeadless({ content, bot: balancedBot, stopAtPhaseId: 'prestige' });
  const greedyRunOne = runHeadless({
    content,
    bot: greedySpenderBot,
    stopAtPhaseId: 'prestige',
  });

  /**
   * The reference player finishes the game. `greedy-spender` reaches the last
   * phase and starts the final print but does not see the credits inside the
   * run limit: it takes Goliath early, so it spends phase 5 rebuilding one
   * enormous bay rather than banking Plates, and arrives at the Fabricator
   * later than the player the budget is written for. That is a real difference
   * between the strategies, so it is asserted rather than papered over.
   */
  it('the reference player finishes; the impatient one is still printing', () => {
    expect(balanced.finalPhaseId).toBe('ended');
    expect(greedy.finalPhaseId).toBe('end');
    expect(idleHeavy.finalPhaseId).not.toBe('ended');
  });

  /**
   * What separates them changed again at M5, and the assertion follows rather
   * than being propped up. Greedy takes Goliath — slower prints, far bigger
   * batches — so it finishes *fewer* prints than the Farm-branch reference
   * while fielding more machines and banking several times the money. It is
   * still the impatient player; it is no longer the busier one.
   */
  it('greedy fields more machines and banks more money, and rushes the bench', () => {
    const machinesOf = (state: { printers: Readonly<Record<string, number>> }): number =>
      Object.values(state.printers).reduce((total, count) => total + count, 0);
    expect(machinesOf(greedyRunOne.finalState)).toBeGreaterThan(
      machinesOf(balancedRunOne.finalState),
    );
    expect(greedyRunOne.finalState.stats.moneyEarned).toBeGreaterThan(
      balancedRunOne.finalState.stats.moneyEarned,
    );
    expect(greedy.phaseDurations.get('bench') ?? 0).toBeLessThan(
      balanced.phaseDurations.get('bench') ?? 0,
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
    const greedyFork = content.forks.find((def) => def.id === greedyRunOne.finalState.forkId);
    const balancedFork = content.forks.find((def) => def.id === balancedRunOne.finalState.forkId);
    expect(greedyFork?.visual).toBe('goliath');
    expect(balancedFork?.visual).toBe('rack');
    expect(greedyRunOne.finalState.slots).toHaveLength(2);
    expect(balancedRunOne.finalState.slots.length).toBeGreaterThan(1);
  });
});

/**
 * The M4 loop end to end (spec §19: a new mechanic means bot support). Every
 * assertion below is something the reference player *did*, through the same
 * reducer the app dispatches into.
 */
describe('the balanced bot plays the M4 loop end to end', () => {
  /*
   * Measured at the end of the studio phase, not at the end of the run: since
   * M5 the melt-down scraps the rack, the fleet and the fork on purpose
   * (spec §5D), so the *final* state of a completed arc is a bare bench and
   * says nothing about whether the M4 loop was ever played.
   */
  const log = runHeadless({ content, bot: REFERENCE_BOT, stopAtPhaseId: 'prestige' });
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

/**
 * The M6 loop end to end (spec §19: a new mechanic means bot support). Every
 * assertion is something the reference player *did*, through the same reducer
 * the app dispatches into.
 */
describe('the balanced bot plays the M6 endgame end to end', () => {
  const log = runHeadless({ content, bot: REFERENCE_BOT });
  const state = log.finalState;

  it('buys the whole Endgame Tree with Plates (spec §5E)', () => {
    for (const def of content.upgrades) {
      if (def.tree === 'endgame') {
        expect(state.upgrades[def.id] ?? 0, def.id).toBeGreaterThan(0);
        expect(def.costResource).toBe('plates');
      }
    }
  });

  it('watches the economy eat itself (spec §6 phase 5)', () => {
    const curves = createCurveRegistry(content.curves);
    expect(state.stats.moneyPrinted).toBeGreaterThan(0);
    expect(inflationMultiplier(state, content, curves)).toBeGreaterThan(1);
  });

  it('pre-prints sections and commits every bay to the last print (§4, §7.3)', () => {
    expect(log.eventCounts.FABRICATOR_SECTION_PRINTED ?? 0).toBeGreaterThan(0);
    expect(log.eventCounts.FABRICATOR_STARTED).toBe(1);
    const fork = content.forks.find((def) => def.id === state.forkId);
    expect(fork?.requiredForFinalPrint).toBe(true);
  });

  it('sees the credits out and lands in the post-game sandbox', () => {
    expect(state.fabricator.completedAtMs).not.toBeNull();
    expect(log.eventCounts.GAME_ENDED).toBe(1);
    expect(state.phaseId).toBe('ended');
  });

  /**
   * New Game Plus is not something the roster does — a bot that restarted the
   * arc would overwrite the timeline the budget gate measures — so it is played
   * by a bot built for exactly that, from the same policy with the knob on.
   */
  it('can start again on the far side of the credits (spec §18 M6)', () => {
    const modifier = content.endgame.newGamePlus.modifiers[0];
    if (modifier === undefined) {
      throw new Error('content must offer a New Game Plus modifier');
    }
    const restarting = createPolicyBot({
      id: 'new-game-plus',
      checkInDesignSeconds: 5,
      capacityFirst: false,
      reserveBatches: 3,
      chaseMargin: true,
      preferFork: 'flexibility',
      useQueues: false,
      newGamePlusModifierIds: [modifier.id],
    });
    const replay = runHeadless({ content, bot: restarting });
    expect(replay.eventCounts.NEW_GAME_PLUS_STARTED ?? 0).toBeGreaterThan(0);
    expect(replay.finalState.ngPlus.run).toBeGreaterThan(0);
    expect(replay.finalState.ngPlus.modifierIds).toEqual([modifier.id]);
    // The Designs came with it; nothing else did.
    expect(Object.keys(replay.finalState.designs).length).toBeGreaterThan(0);
    expect(replay.finalState.upgrades['universal-fabricator']).toBeUndefined();
  });
});

describe('placeholder phases (spec §18)', () => {
  /**
   * There are none left — M6 gave the last two phases real gates — so the test
   * now proves the *detector* rather than the content: a phase gated only on
   * the clock is a placeholder, and one gated on anything else is not. Keeping
   * it means the rule still holds if a later milestone stubs a phase again.
   */
  it('are recognised from their gate, not from a list of names', () => {
    const byId = new Map(content.pacing.phases.map((phase) => [phase.id, phase]));
    const absurd = byId.get('absurd');
    if (absurd === undefined) {
      throw new Error('expected the spec §6 phases');
    }
    expect(isPlaceholderPhase(absurd)).toBe(false);
    expect(
      isPlaceholderPhase({
        ...absurd,
        advanceWhen: [{ metric: 'phaseDesignMinutes', atLeast: 80 } as never],
      }),
    ).toBe(true);
    expect(
      isPlaceholderPhase({ ...absurd, advanceWhen: [{ metric: 'designs', atLeast: 1 } as never] }),
    ).toBe(false);
  });
});
