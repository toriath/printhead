import type { GatedActionType, PhaseDef } from '../content/schema.js';

/**
 * Phase FSM (spec §15) as a generic interpreter over `pacing.phases`.
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11) —
 * CI enforces this with `pnpm literals:check`.
 */
export const NOT_FOUND = -1;
const STEP = 1;

export function phaseIndex(phases: readonly PhaseDef[], phaseId: string): number {
  return phases.findIndex((phase) => phase.id === phaseId);
}

export function isKnownPhase(phases: readonly PhaseDef[], phaseId: string): boolean {
  return phaseIndex(phases, phaseId) !== NOT_FOUND;
}

export function firstPhaseId(phases: readonly PhaseDef[]): string {
  const first = phases.at(0);
  if (first === undefined) {
    throw new RangeError('pacing.phases must not be empty');
  }
  return first.id;
}

export function lastPhaseId(phases: readonly PhaseDef[]): string {
  const last = phases.at(NOT_FOUND);
  if (last === undefined) {
    throw new RangeError('pacing.phases must not be empty');
  }
  return last.id;
}

/** The next phase in content order, or `null` when the game has ended. */
export function nextPhaseId(phases: readonly PhaseDef[], phaseId: string): string | null {
  const index = phaseIndex(phases, phaseId);
  if (index === NOT_FOUND) {
    throw new RangeError(`unknown phase id: ${phaseId}`);
  }
  return phases.at(index + STEP)?.id ?? null;
}

/** True when `currentPhaseId` is at or past `requiredPhaseId` — the unlock gate. */
export function isPhaseReached(
  phases: readonly PhaseDef[],
  currentPhaseId: string,
  requiredPhaseId: string,
): boolean {
  const current = phaseIndex(phases, currentPhaseId);
  const required = phaseIndex(phases, requiredPhaseId);
  if (current === NOT_FOUND) {
    throw new RangeError(`unknown phase id: ${currentPhaseId}`);
  }
  if (required === NOT_FOUND) {
    throw new RangeError(`unknown phase id: ${requiredPhaseId}`);
  }
  return current >= required;
}

export function getPhase(phases: readonly PhaseDef[], phaseId: string): PhaseDef {
  const phase = phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) {
    throw new RangeError(`unknown phase id: ${phaseId}`);
  }
  return phase;
}

/** The FSM gate: content decides which player actions a phase permits (spec §15). */
export function isActionAllowed(
  phases: readonly PhaseDef[],
  phaseId: string,
  actionType: GatedActionType,
): boolean {
  return getPhase(phases, phaseId).allowedActions.includes(actionType);
}

/** Cumulative design-minute budget up to and including `phaseId` (spec §6). */
export function budgetThroughPhase(phases: readonly PhaseDef[], phaseId: string): number {
  const index = phaseIndex(phases, phaseId);
  if (index === NOT_FOUND) {
    throw new RangeError(`unknown phase id: ${phaseId}`);
  }
  return phases
    .slice(0, index + STEP)
    .reduce((total, phase) => total + phase.budgetDesignMinutes, 0);
}

export function totalBudgetDesignMinutes(phases: readonly PhaseDef[]): number {
  return phases.reduce((total, phase) => total + phase.budgetDesignMinutes, 0);
}
