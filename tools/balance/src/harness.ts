import {
  type Action,
  type Content,
  type GameState,
  MS_PER_SECOND,
  type PaceMapping,
  type ReduceContext,
  advance,
  createInitialState,
  createPaceMapping,
  createRng,
  reduce,
  restoreRng,
  totalBudgetDesignMinutes,
} from '@printhead/core';
import { designMinutesOf, wallHoursOf } from './budget.js';

/**
 * Headless harness (spec §12.1): runs the real `core` at maximum speed with a
 * pluggable bot. M0 has no economy yet, so the harness proves the plumbing —
 * ticks, pace, phase transitions and a run log. M1 grows the bots.
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
   * Defaults to the total §6 budget from `pacing.json`.
   */
  readonly limitDesignMinutes?: number;
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
  readonly phaseEnteredAt: ReadonlyMap<string, number>;
}

const DEFAULT_SEED = 1;

export function runHeadless(options: RunOptions): RunLog {
  const { content, bot } = options;
  const pace: PaceMapping = createPaceMapping(content.pacing);
  const limit = options.limitDesignMinutes ?? totalBudgetDesignMinutes(content.pacing.phases);
  const stepWallMs = pace.toWallDtMs(bot.checkInDesignSeconds * MS_PER_SECOND);

  let state = createInitialState(content, { seed: options.seed ?? DEFAULT_SEED });
  let carrySimMs = 0;
  let ticks = 0;
  let decisions = 0;
  let actions = 0;

  const phaseEnteredAt = new Map<string, number>([[state.phaseId, 0]]);
  const phaseDurations = new Map<string, number>();

  const ctx = (): ReduceContext => ({
    content,
    nowMs: state.simTimeMs,
    rng: restoreRng(state.rng),
  });

  const observePhase = (previousPhaseId: string): void => {
    if (state.phaseId === previousPhaseId) {
      return;
    }
    const enteredAt = phaseEnteredAt.get(previousPhaseId) ?? 0;
    phaseDurations.set(previousPhaseId, designMinutesOf(state.simTimeMs) - enteredAt);
    phaseEnteredAt.set(state.phaseId, designMinutesOf(state.simTimeMs));
  };

  while (designMinutesOf(state.simTimeMs) < limit) {
    const before = state.phaseId;
    const chosen = bot.decide({
      state,
      content,
      designMinutes: designMinutesOf(state.simTimeMs),
    });
    decisions += 1;
    for (const action of chosen) {
      state = reduce(state, action, ctx());
      actions += 1;
    }
    observePhase(before);

    const stepCtx = ctx();
    const result = advance({
      state,
      carrySimMs,
      wallDtMs: stepWallMs,
      pace,
      tick: (current, simDtMs) => reduce(current, { type: 'TICK', simDtMs }, stepCtx),
    });
    state = result.state;
    carrySimMs = result.carrySimMs;
    ticks += result.ticks;
    if (result.ticks === 0) {
      throw new Error(`bot "${bot.id}" check-in interval is shorter than one tick`);
    }
  }

  const enteredAt = phaseEnteredAt.get(state.phaseId) ?? 0;
  phaseDurations.set(state.phaseId, designMinutesOf(state.simTimeMs) - enteredAt);

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
  };
}

/** Exposed so bots can draw deterministically without importing core directly. */
export const forkBotRng = createRng;
