import {
  MS_PER_HOUR,
  MS_PER_MINUTE,
  type PaceMapping,
  type PacingContent,
  type PhaseDef,
  totalBudgetDesignMinutes,
} from '@printhead/core';

/**
 * Phase budgets from `content/pacing.json` (spec §6) turned into assertions
 * (spec §12.6). Balance regressions must fail CI exactly like a unit test.
 */
export interface PhaseBudget {
  readonly phaseId: string;
  readonly name: string;
  readonly budgetDesignMinutes: number;
  readonly minDesignMinutes: number;
  readonly maxDesignMinutes: number;
  readonly waitWallBudgetDesignMinutes: number;
}

export interface BudgetTable {
  readonly tolerance: number;
  readonly totalDesignMinutes: number;
  readonly phases: readonly PhaseBudget[];
}

export function buildBudgetTable(pacing: PacingContent): BudgetTable {
  const tolerance = pacing.phaseBudgetTolerance;
  return {
    tolerance,
    totalDesignMinutes: totalBudgetDesignMinutes(pacing.phases),
    phases: pacing.phases.map((phase: PhaseDef) => ({
      phaseId: phase.id,
      name: phase.name,
      budgetDesignMinutes: phase.budgetDesignMinutes,
      minDesignMinutes: phase.budgetDesignMinutes * (1 - tolerance),
      maxDesignMinutes: phase.budgetDesignMinutes * (1 + tolerance),
      waitWallBudgetDesignMinutes: phase.waitWallBudgetDesignMinutes,
    })),
  };
}

export interface BudgetViolation {
  readonly phaseId: string;
  readonly actualDesignMinutes: number;
  readonly budgetDesignMinutes: number;
  readonly reason: 'too-fast' | 'too-slow' | 'never-reached';
}

/** `durations` maps phaseId → design minutes the bot spent in that phase. */
export function checkPhaseBudgets(
  table: BudgetTable,
  durations: ReadonlyMap<string, number>,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const phase of table.phases) {
    const actual = durations.get(phase.phaseId);
    if (actual === undefined) {
      violations.push({
        phaseId: phase.phaseId,
        actualDesignMinutes: Number.NaN,
        budgetDesignMinutes: phase.budgetDesignMinutes,
        reason: 'never-reached',
      });
      continue;
    }
    if (actual < phase.minDesignMinutes) {
      violations.push({
        phaseId: phase.phaseId,
        actualDesignMinutes: actual,
        budgetDesignMinutes: phase.budgetDesignMinutes,
        reason: 'too-fast',
      });
    } else if (actual > phase.maxDesignMinutes) {
      violations.push({
        phaseId: phase.phaseId,
        actualDesignMinutes: actual,
        budgetDesignMinutes: phase.budgetDesignMinutes,
        reason: 'too-slow',
      });
    }
  }
  return violations;
}

export const designMinutesOf = (simTimeMs: number): number => simTimeMs / MS_PER_MINUTE;

/** What the budget means for a real player at the configured `targetHours`. */
export const wallHoursOf = (simTimeMs: number, pace: PaceMapping): number =>
  pace.toWallDtMs(simTimeMs) / MS_PER_HOUR;
