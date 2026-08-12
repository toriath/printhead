import { advancePhase, budgetThroughPhase } from '@printhead/core';
import type { Bot } from './harness.js';

/**
 * Bot strategies (spec §12.1). The real `greedy-spender` / `balanced` /
 * `idle-heavy` trio needs an economy to play with (M1); M0 ships the two bots
 * that can exist without one, so the harness and the CI budget assertion are
 * live from the start.
 */
const CHECK_IN_SECONDS = 10;
const IDLE_CHECK_IN_SECONDS = 600;

/** Does nothing at all — the lower bound on progress. */
export const idleBot: Bot = {
  id: 'idle',
  checkInDesignSeconds: IDLE_CHECK_IN_SECONDS,
  decide: () => [],
};

/**
 * Walks the phase FSM exactly on the spec §6 budget. Until real mechanics
 * exist, this is the reference "on-budget player" the CI check measures.
 */
export const budgetPacedBot: Bot = {
  id: 'budget-paced',
  checkInDesignSeconds: CHECK_IN_SECONDS,
  decide: ({ state, content, designMinutes }) => {
    const cumulative = budgetThroughPhase(content.pacing.phases, state.phaseId);
    return designMinutes >= cumulative ? [advancePhase()] : [];
  },
};

export const BOTS: readonly Bot[] = [idleBot, budgetPacedBot];

export function findBot(id: string): Bot {
  const bot = BOTS.find((candidate) => candidate.id === id);
  if (bot === undefined) {
    throw new Error(`unknown bot: ${id} (known: ${BOTS.map((b) => b.id).join(', ')})`);
  }
  return bot;
}
