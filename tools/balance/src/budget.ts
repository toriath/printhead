import {
  type Content,
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

/**
 * A phase whose only gate is the clock has no mechanics behind it yet — it is a
 * placeholder waiting for a later milestone (spec §18). The distinction is read
 * from `advanceWhen` rather than from a list of phase ids, so a phase stops
 * being a placeholder the moment content gives it something to gate on, and no
 * tool has to be told.
 *
 * It matters because the wait-wall detector is *right* to report a dead zone in
 * a phase where the player has nothing to buy. Raising those budgets to make
 * the report green would hide the fact; scoping the gate records it.
 */
export function isPlaceholderPhase(phase: PhaseDef): boolean {
  return phase.advanceWhen.every((requirement) => requirement.metric === 'phaseDesignMinutes');
}

export function gatedPhaseIds(content: Content): readonly string[] {
  return content.pacing.phases
    .filter((phase) => !isPlaceholderPhase(phase))
    .map((phase) => phase.id);
}

export const designMinutesOf = (simTimeMs: number): number => simTimeMs / MS_PER_MINUTE;

/** What the budget means for a real player at the configured `targetHours`. */
export const wallHoursOf = (simTimeMs: number, pace: PaceMapping): number =>
  pace.toWallDtMs(simTimeMs) / MS_PER_HOUR;
