/**
 * Command pattern (spec §15): every state change is an Action fed to the single
 * pure `reduce`. `TICK` is an action like any other, which is what makes
 * replay, offline catch-up and bot harnesses share one code path.
 */
export interface TickAction {
  readonly type: 'TICK';
  readonly simDtMs: number;
}

export interface AdvancePhaseAction {
  readonly type: 'ADVANCE_PHASE';
}

export type Action = TickAction | AdvancePhaseAction;

export type ActionType = Action['type'];

export const tick = (simDtMs: number): TickAction => ({ type: 'TICK', simDtMs });
export const advancePhase = (): AdvancePhaseAction => ({ type: 'ADVANCE_PHASE' });
