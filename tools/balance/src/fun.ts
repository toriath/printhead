import type { ActionType, Content } from '@printhead/core';
import { designMinutesOf } from './budget.js';
import type { RunLog } from './harness.js';

/**
 * Fun signals (spec §12, extended). The phase budgets say whether the game is
 * the right *length*; none of them says whether those minutes are any good. A
 * fit can hit every budget with an hour of nothing followed by a burst of
 * unlocks, or with a click-chore repeated eight hundred times. These read the
 * same run log for the things a player actually feels:
 *
 * - **Droughts**: the longest stretch in a phase with nothing *new* — no new
 *   upgrade, machine, material, design, branch or phase. Not the same as a wait
 *   wall: a player can have plenty to buy and still have seen it all before.
 * - **Chores**: the share of actions that are upkeep (sell, recycle, restock,
 *   reload) rather than decisions. Upkeep the player repeats hundreds of times
 *   is a candidate for automation, which is what the automation tree is for.
 * - **Dead content**: nodes no bot ever bought. Either dominated or unreachable.
 * - **Divergence**: whether two strategies bought things in a different order.
 *   If every strategy converges on one build order, the choices are not choices.
 *
 * Bots are not players, so none of these are verdicts. They are where to look.
 */

/** A first-time event: something the player has not seen before this run. */
export interface NoveltyMoment {
  readonly designMinutes: number;
  readonly label: string;
}

/** Actions that keep the workshop running rather than change what it is. */
export const CHORE_ACTIONS: readonly ActionType[] = [
  'SELL_PARTS',
  'SELL_PRODUCTS',
  'RECYCLE_SCRAP',
  'BUY_FILAMENT',
  'SELL_FILAMENT',
  'START_PRINT',
  'SET_SLOT_CONFIG',
  'SET_AUTOMATION',
];

/**
 * Every first in the run, in order. Repeats of something already seen (a
 * second printer, a second melt-down) are not novel and are left out.
 */
export function noveltyMoments(log: RunLog): readonly NoveltyMoment[] {
  const seen = new Set<string>();
  const moments: NoveltyMoment[] = [];
  const mark = (simTimeMs: number, key: string, label: string): void => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    moments.push({ designMinutes: designMinutesOf(simTimeMs), label });
  };
  for (const event of log.events) {
    switch (event.type) {
      case 'ASSEMBLY_COMPLETED':
        mark(event.simTimeMs, 'assembly', 'printer #1 wakes up');
        break;
      case 'UPGRADE_INSTALLED':
        mark(event.simTimeMs, `upgrade:${event.upgradeId}`, `upgrade ${event.upgradeId}`);
        break;
      case 'AUTOMATION_INSTALLED':
        mark(event.simTimeMs, `auto:${event.automationId}`, `automation ${event.automationId}`);
        break;
      case 'SLOT_CONFIGURED':
        mark(event.simTimeMs, `material:${event.materialId}`, `first ${event.materialId} print`);
        break;
      case 'SLOT_UNLOCKED':
        mark(event.simTimeMs, `slot:${event.slotCount}`, `bay ${event.slotCount}`);
        break;
      case 'DESIGN_CREATED':
        mark(event.simTimeMs, `design:${event.designId}`, `design ${event.designId}`);
        break;
      case 'FORK_CHOSEN':
        mark(event.simTimeMs, `fork:${event.forkId}`, `fork ${event.forkId}`);
        break;
      case 'PRESTIGED':
        mark(event.simTimeMs, 'prestige', 'first melt-down');
        break;
      case 'MONEY_PRINTER_INSTALLED':
        mark(event.simTimeMs, `press:${event.moneyPrinterId}`, `press ${event.moneyPrinterId}`);
        break;
      case 'PRINT_COMPLETED':
        if (event.perfect) {
          mark(event.simTimeMs, 'perfect', 'first perfect print');
        }
        break;
      case 'FABRICATOR_STARTED':
        mark(event.simTimeMs, 'fabricator', 'the final print');
        break;
      case 'PHASE_ADVANCED':
        mark(event.simTimeMs, `phase:${event.toPhaseId}`, `phase ${event.toPhaseId}`);
        break;
      default:
        break;
    }
  }
  return moments;
}

/**
 * phaseId → the longest gap, in design minutes, between novelty moments while
 * the run was in that phase. The phase's entry counts as a moment (it is one:
 * a new phase is new), and so does its exit, so a phase where nothing new ever
 * happens reports its whole length.
 */
export function longestDroughtByPhase(log: RunLog): ReadonlyMap<string, number> {
  const moments = noveltyMoments(log).map((moment) => moment.designMinutes);
  const result = new Map<string, number>();
  for (const [phaseId, enteredAt] of log.phaseEnteredAt) {
    const duration = log.phaseDurations.get(phaseId) ?? 0;
    const leftAt = enteredAt + duration;
    const inside = moments.filter((minute) => minute > enteredAt && minute < leftAt);
    const marks = [enteredAt, ...inside, leftAt];
    let longest = 0;
    for (let i = 1; i < marks.length; i += 1) {
      longest = Math.max(longest, (marks[i] ?? 0) - (marks[i - 1] ?? 0));
    }
    result.set(phaseId, longest);
  }
  return result;
}

/** Share of the run's actions that are upkeep, 0..1. */
export function choreShare(log: RunLog): number {
  let chores = 0;
  let total = 0;
  for (const [type, count] of Object.entries(log.actionsByType) as [ActionType, number][]) {
    total += count;
    if (CHORE_ACTIONS.includes(type)) {
      chores += count;
    }
  }
  return total === 0 ? 0 : chores / total;
}

/** The single most repeated action, the first candidate for automation. */
export function topChore(
  log: RunLog,
): { readonly type: ActionType; readonly count: number } | null {
  let best: { type: ActionType; count: number } | null = null;
  for (const [type, count] of Object.entries(log.actionsByType) as [ActionType, number][]) {
    if (CHORE_ACTIONS.includes(type) && (best === null || count > best.count)) {
      best = { type, count };
    }
  }
  return best;
}

/**
 * Ids of purchasable content no run acquired *while the game was still on*.
 * Buying something in the post-game sandbox does not count: content that only
 * ever gets bought after the credits never mattered to the arc. Found exactly
 * that way: the second design, the sintering head and the last two bays were
 * all bought minutes after the final print, by every bot.
 */
export function deadContent(logs: readonly RunLog[], content: Content): readonly string[] {
  const terminal = content.pacing.phases.at(-1)?.id;
  const used = new Set<string>();
  for (const log of logs) {
    const endedAt = terminal === undefined ? undefined : log.phaseEnteredAt.get(terminal);
    for (const event of log.events) {
      if (endedAt !== undefined && designMinutesOf(event.simTimeMs) >= endedAt) {
        break;
      }
      if (event.type === 'UPGRADE_INSTALLED') used.add(event.upgradeId);
      if (event.type === 'AUTOMATION_INSTALLED') used.add(event.automationId);
      if (event.type === 'DESIGN_CREATED') used.add(event.designId);
      if (event.type === 'MONEY_PRINTER_INSTALLED') used.add(event.moneyPrinterId);
      if (event.type === 'FORK_CHOSEN') used.add(event.forkId);
    }
  }
  const all = [
    ...content.upgrades.map((def) => def.id),
    ...content.automation.map((def) => def.id),
    ...content.designs.map((def) => def.id),
    ...content.prestige.moneyPrinters.map((def) => def.id),
    ...content.forks.map((def) => def.id),
  ];
  return all.filter((id) => !used.has(id));
}

/** The order a run first acquired each purchasable thing in. */
export function buildOrder(log: RunLog): readonly string[] {
  return noveltyMoments(log)
    .map((moment) => moment.label)
    .filter((label) => !label.startsWith('phase ') && !label.startsWith('first '));
}

/**
 * How differently two runs ordered the things they both bought, 0..1: the share
 * of shared pairs whose order disagrees (a normalised Kendall distance). 0 means
 * the same build order; around 0.5, unrelated orders.
 */
export function orderDivergence(a: readonly string[], b: readonly string[]): number {
  const shared = a.filter((item) => b.includes(item));
  let pairs = 0;
  let disagree = 0;
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      pairs += 1;
      const first = shared[i] as string;
      const second = shared[j] as string;
      if (b.indexOf(first) > b.indexOf(second)) {
        disagree += 1;
      }
    }
  }
  return pairs === 0 ? 0 : disagree / pairs;
}
