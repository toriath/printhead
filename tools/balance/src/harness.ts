import {
  type Action,
  type ActionType,
  type Content,
  type DomainEvent,
  type DomainEventType,
  type GameState,
  MS_PER_SECOND,
  type PaceMapping,
  type ReduceContext,
  TICK_MS,
  advance,
  countEventsByType,
  createCurveRegistry,
  createEventBus,
  createInitialState,
  createPaceMapping,
  createRng,
  reduce,
  restoreRng,
} from '@printhead/core';
import { buildBudgetTable, designMinutesOf, wallHoursOf } from './budget.js';
import { type WaitWall, WaitWallTracker, meaningfulOptions } from './waitwall.js';

/**
 * Headless harness (spec §12.1): runs the real `core` at maximum speed with a
 * pluggable bot strategy and records what happened — phase completion times,
 * resource curves, decision and action counts.
 *
 * Nothing here is a simulation of its own. The bot only emits `Action`s and the
 * harness feeds them to the same `reduce` the app uses, so a number the harness
 * reports is a number the game really produces.
 */
export interface BotView {
  readonly state: GameState;
  readonly content: Content;
  readonly designMinutes: number;
}

export interface Bot {
  readonly id: string;
  /** Sim seconds between check-ins — `idle-heavy` bots use large values. */
  readonly checkInDesignSeconds: number;
  decide(view: BotView): readonly Action[];
}

export interface RunOptions {
  readonly content: Content;
  readonly bot: Bot;
  readonly seed?: number;
  /**
   * Hard stop, in design minutes, so a stuck bot cannot spin forever.
   *
   * Defaults to the spec §6 arc budget **plus its own tolerance**, plus the
   * terminal sandbox's nominal length. A limit set to the budget exactly cannot
   * observe a phase that legitimately runs to +20 %: the run is cut off mid-arc
   * and the last phase is reported as never reached, which is a fact about the
   * limit rather than about the game.
   */
  readonly limitDesignMinutes?: number;
  /** Stop as soon as this phase is entered — used to time the early phases. */
  readonly stopAtPhaseId?: string;
  /** Design minutes between resource-curve samples. */
  readonly sampleEveryDesignMinutes?: number;
}

/** One point on the resource curves the report plots (spec §12.5). */
export interface ResourceSample {
  readonly designMinutes: number;
  readonly phaseId: string;
  readonly parts: number;
  readonly money: number;
  readonly filamentGrams: number;
  readonly printers: number;
  readonly printsCompleted: number;
  /** Money the presses have printed — the reading inflation is read at (§6). */
  readonly moneyPrinted: number;
}

export interface RunLog {
  readonly botId: string;
  readonly ticks: number;
  readonly decisions: number;
  readonly actions: number;
  readonly designMinutes: number;
  readonly wallHours: number;
  readonly finalPhaseId: string;
  /** phaseId → design minutes spent in that phase. */
  readonly phaseDurations: ReadonlyMap<string, number>;
  /** phaseId → design minutes on the clock when the phase was entered. */
  readonly phaseEnteredAt: ReadonlyMap<string, number>;
  /** phaseId → how many times the bot was asked to decide while in it. */
  readonly decisionsByPhase: ReadonlyMap<string, number>;
  readonly actionsByType: Readonly<Partial<Record<ActionType, number>>>;
  readonly eventCounts: Readonly<Partial<Record<DomainEventType, number>>>;
  /**
   * Every domain event, in order, with the simulation clock it fired at. The
   * counts answer "did it happen?"; the log answers "when?", which is the first
   * question asked of a phase that overran its budget.
   */
  readonly events: readonly DomainEvent[];
  readonly samples: readonly ResourceSample[];
  /** Stretches with nothing meaningful to do (spec §12.2). */
  readonly waitWalls: readonly WaitWall[];
  readonly finalState: GameState;
}

const DEFAULT_SEED = 1;
const DEFAULT_SAMPLE_EVERY_DESIGN_MINUTES = 1;

function totalPrinters(state: GameState): number {
  let total = 0;
  for (const owned of Object.values(state.printers)) {
    total += owned;
  }
  return total;
}

function totalFilament(state: GameState): number {
  let total = 0;
  for (const grams of Object.values(state.filamentGrams)) {
    total += grams;
  }
  return total;
}

function sampleOf(state: GameState): ResourceSample {
  return {
    designMinutes: designMinutesOf(state.simTimeMs),
    phaseId: state.phaseId,
    parts: state.resources.parts,
    money: state.resources.money,
    filamentGrams: totalFilament(state),
    printers: totalPrinters(state),
    printsCompleted: state.stats.printsCompleted,
    moneyPrinted: state.stats.moneyPrinted,
  };
}

export function runHeadless(options: RunOptions): RunLog {
  const { content, bot } = options;
  const pace: PaceMapping = createPaceMapping(content.pacing);
  const table = buildBudgetTable(content.pacing);
  const sandbox =
    content.pacing.phases.find((phase) => phase.id === table.terminalPhaseId)
      ?.budgetDesignMinutes ?? 0;
  const limit =
    options.limitDesignMinutes ?? table.totalDesignMinutes * (1 + table.arcTolerance) + sandbox;
  const stepWallMs = pace.toWallDtMs(bot.checkInDesignSeconds * MS_PER_SECOND);
  const sampleEvery = options.sampleEveryDesignMinutes ?? DEFAULT_SAMPLE_EVERY_DESIGN_MINUTES;
  const bus = createEventBus();

  let state = createInitialState(content, { seed: options.seed ?? DEFAULT_SEED });
  /*
   * How much time the run has *simulated*, which is not the same as what the
   * clock says: New Game Plus (spec §18 M6) starts the arc again with the clock
   * back at zero, and a loop bounded by `state.simTimeMs` would never end —
   * the bot finishes the game, restarts it, and rewinds the very number the
   * harness was watching. Found exactly that way: a run that should have taken
   * two seconds ran until the test timeout killed it.
   */
  let elapsedSimMs = 0;
  let carrySimMs = 0;
  let ticks = 0;
  let decisions = 0;
  let actions = 0;
  let nextSampleAt = 0;

  const actionsByType: Partial<Record<ActionType, number>> = {};
  const decisionsByPhase = new Map<string, number>();
  const phaseEnteredAt = new Map<string, number>([[state.phaseId, 0]]);
  const phaseDurations = new Map<string, number>();
  const samples: ResourceSample[] = [];
  const curves = createCurveRegistry(content.curves);
  const waitWalls = new WaitWallTracker();
  const events: DomainEvent[] = [];
  bus.subscribe((event) => events.push(event));

  const ctx = (): ReduceContext => ({
    content,
    nowMs: state.simTimeMs,
    rng: restoreRng(state.rng),
    emit: bus.emit,
  });

  /**
   * The timeline is built from `PHASE_ADVANCED` events rather than by comparing
   * the phase before and after each step. A single tick can walk more than one
   * gate — the FSM advances while its requirements are met — and a before/after
   * comparison would silently drop every phase passed through in between,
   * reporting a real phase as "never reached".
   */
  bus.on('PHASE_ADVANCED', (event) => {
    const at = designMinutesOf(event.simTimeMs);
    const enteredAt = phaseEnteredAt.get(event.fromPhaseId) ?? 0;
    phaseDurations.set(event.fromPhaseId, at - enteredAt);
    phaseEnteredAt.set(event.toPhaseId, at);
  });

  const maybeSample = (): void => {
    const minutes = designMinutesOf(state.simTimeMs);
    if (minutes >= nextSampleAt) {
      samples.push(sampleOf(state));
      nextSampleAt = minutes + sampleEvery;
    }
  };

  maybeSample();

  while (designMinutesOf(elapsedSimMs) < limit) {
    if (options.stopAtPhaseId !== undefined && state.phaseId === options.stopAtPhaseId) {
      break;
    }
    const decidingIn = state.phaseId;
    // Sampled *before* the bot acts: the question is what was on offer, not
    // what the bot happened to pick.
    waitWalls.sample(
      designMinutesOf(state.simTimeMs),
      decidingIn,
      meaningfulOptions(state, content, curves).length > 0,
    );
    const chosen = bot.decide({
      state,
      content,
      designMinutes: designMinutesOf(state.simTimeMs),
    });
    decisions += 1;
    decisionsByPhase.set(decidingIn, (decisionsByPhase.get(decidingIn) ?? 0) + 1);
    for (const action of chosen) {
      state = reduce(state, action, ctx());
      actions += 1;
      actionsByType[action.type] = (actionsByType[action.type] ?? 0) + 1;
    }

    const result = advance({
      state,
      carrySimMs,
      wallDtMs: stepWallMs,
      pace,
      // A fresh ctx per tick keeps the rng stream anchored to the state that
      // is actually being reduced, exactly as the app store does.
      tick: (current, simDtMs) =>
        reduce(current, { type: 'TICK', simDtMs }, { ...ctx(), rng: restoreRng(current.rng) }),
    });
    // Ticks, not clocks: `advance` runs whole `TICK_MS` steps, so this is
    // exactly the time simulated — and it cannot be rewound by a restart.
    elapsedSimMs += result.ticks * TICK_MS;
    state = result.state;
    carrySimMs = result.carrySimMs;
    ticks += result.ticks;
    if (result.ticks === 0) {
      throw new Error(`bot "${bot.id}" check-in interval is shorter than one tick`);
    }
    maybeSample();
  }

  const enteredAt = phaseEnteredAt.get(state.phaseId) ?? 0;
  phaseDurations.set(state.phaseId, designMinutesOf(state.simTimeMs) - enteredAt);
  samples.push(sampleOf(state));

  return {
    botId: bot.id,
    ticks,
    decisions,
    actions,
    designMinutes: designMinutesOf(state.simTimeMs),
    wallHours: wallHoursOf(state.simTimeMs, pace),
    finalPhaseId: state.phaseId,
    phaseDurations,
    phaseEnteredAt,
    decisionsByPhase,
    actionsByType,
    eventCounts: countEventsByType(events),
    events,
    samples,
    waitWalls: waitWalls.finish(),
    finalState: state,
  };
}

/** Exposed so bots can draw deterministically without importing core directly. */
export const forkBotRng = createRng;
