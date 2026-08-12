import type { Content, Metric, Requirement } from '../content/schema.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import type { GameState } from '../state/game-state.js';

/**
 * Data-driven progression gates (spec §11/§15). Content names a metric and a
 * threshold; this interpreter is the only code that knows how to read a metric,
 * so a new phase gate is a JSON edit plus (at most) one case here.
 */
const NONE = 0;
const ALL = 1;

export function countPrinters(state: GameState): number {
  let total = NONE;
  for (const owned of Object.values(state.printers)) {
    total += owned;
  }
  return total;
}

export function assemblyProgress(state: GameState, content: Content): number {
  const total = content.start.assemblyPieces.length;
  return total > NONE ? state.assembly.attachedPieceIds.length / total : ALL;
}

export function phaseDesignMinutes(state: GameState): number {
  return (state.simTimeMs - state.phaseEnteredAtMs) / MS_PER_MINUTE;
}

export function totalDesignMinutes(state: GameState): number {
  return state.simTimeMs / MS_PER_MINUTE;
}

export function readMetric(state: GameState, content: Content, metric: Metric): number {
  switch (metric) {
    case 'parts':
      return state.resources.parts;
    case 'scrap':
      return state.resources.scrap;
    case 'money':
      return state.resources.money;
    case 'printers':
      return countPrinters(state);
    case 'partsProduced':
      return state.stats.partsProduced;
    case 'partsSold':
      return state.stats.partsSold;
    case 'printsCompleted':
      return state.stats.printsCompleted;
    case 'piecesAttached':
      return state.assembly.attachedPieceIds.length;
    case 'assemblyProgress':
      return assemblyProgress(state, content);
    case 'phaseDesignMinutes':
      return phaseDesignMinutes(state);
    case 'totalDesignMinutes':
      return totalDesignMinutes(state);
  }
}

export function meetsRequirement(
  state: GameState,
  content: Content,
  requirement: Requirement,
): boolean {
  return readMetric(state, content, requirement.metric) >= requirement.atLeast;
}

/** All requirements must hold — an empty list would mean "always", so content forbids it. */
export function meetsRequirements(
  state: GameState,
  content: Content,
  requirements: readonly Requirement[],
): boolean {
  return requirements.every((requirement) => meetsRequirement(state, content, requirement));
}

export interface RequirementProgress {
  readonly metric: Metric;
  readonly atLeast: number;
  readonly actual: number;
  readonly met: boolean;
}

/** What is still missing before the phase advances — for the HUD and the bots. */
export function requirementProgress(
  state: GameState,
  content: Content,
  requirements: readonly Requirement[],
): readonly RequirementProgress[] {
  return requirements.map((requirement) => {
    const actual = readMetric(state, content, requirement.metric);
    return {
      metric: requirement.metric,
      atLeast: requirement.atLeast,
      actual,
      met: actual >= requirement.atLeast,
    };
  });
}
