import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import {
  NOT_FOUND,
  budgetThroughPhase,
  firstPhaseId,
  isKnownPhase,
  isPhaseReached,
  lastPhaseId,
  nextPhaseId,
  phaseIndex,
  totalBudgetDesignMinutes,
} from './phases.js';

const phases = loadContent(RAW_CONTENT).pacing.phases;

describe('phase FSM', () => {
  it('reads the phase order from content', () => {
    expect(phases.map((phase) => phase.id)).toEqual([
      'intro',
      'bench',
      'farm',
      'studio',
      'prestige',
      'absurd',
      'end',
      // The FSM runs "Intro → … → Ended" (spec §15). `ended` is the terminal
      // state: the post-game sandbox, which nothing advances out of.
      'ended',
    ]);
  });

  it('finds first, last and index', () => {
    expect(firstPhaseId(phases)).toBe('intro');
    expect(lastPhaseId(phases)).toBe('ended');
    expect(phaseIndex(phases, 'farm')).toBe(2);
    expect(isKnownPhase(phases, 'farm')).toBe(true);
    expect(isKnownPhase(phases, 'nope')).toBe(false);
  });

  it('walks forward and stops at the end', () => {
    expect(nextPhaseId(phases, 'intro')).toBe('bench');
    expect(nextPhaseId(phases, 'absurd')).toBe('end');
    expect(nextPhaseId(phases, 'end')).toBe('ended');
    expect(nextPhaseId(phases, 'ended')).toBeNull();
  });

  it('gates unlocks by phase order', () => {
    expect(isPhaseReached(phases, 'farm', 'bench')).toBe(true);
    expect(isPhaseReached(phases, 'farm', 'farm')).toBe(true);
    expect(isPhaseReached(phases, 'bench', 'studio')).toBe(false);
  });

  it('throws on unknown phases instead of silently passing', () => {
    expect(() => nextPhaseId(phases, 'nope')).toThrow('unknown phase id: nope');
    expect(() => isPhaseReached(phases, 'nope', 'intro')).toThrow('unknown phase id: nope');
    expect(() => isPhaseReached(phases, 'intro', 'nope')).toThrow('unknown phase id: nope');
    expect(() => budgetThroughPhase(phases, 'nope')).toThrow('unknown phase id: nope');
    expect(() => firstPhaseId([])).toThrow('pacing.phases must not be empty');
    expect(() => lastPhaseId([])).toThrow('pacing.phases must not be empty');
    expect(() => nextPhaseId(phases, 'nope')).toThrow(RangeError);
  });

  it('reports NOT_FOUND for unknown ids', () => {
    expect(phaseIndex(phases, 'nope')).toBe(NOT_FOUND);
    expect(NOT_FOUND).toBe(-1);
  });

  it('accumulates the spec §6 design-minute budgets', () => {
    expect(budgetThroughPhase(phases, 'intro')).toBe(5);
    expect(budgetThroughPhase(phases, 'bench')).toBe(35);
    expect(budgetThroughPhase(phases, 'end')).toBe(420);
    // The terminal sandbox is outside the arc's 420-minute budget (spec §6);
    // its nominal five minutes are what the harness uses as a run-out.
    expect(totalBudgetDesignMinutes(phases)).toBe(425);
  });
});
