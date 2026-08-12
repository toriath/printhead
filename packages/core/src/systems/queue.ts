import { indexById } from '../content/load.js';
import type { AutomationDef, Content } from '../content/schema.js';
import type { GameState, SlotQueueEntry, SlotState } from '../state/game-state.js';

/**
 * Print queues (spec §5B: "print queues — auto-changeover per slot").
 *
 * A queue is a rota of `{ material, object, batches }` entries written onto a
 * slot. On its own it is inert documentation: the slot prints whatever entry is
 * loaded and stops there. The **auto-changeover automation** is what makes the
 * rota turn — friction first, then the upgrade that removes it (spec §5C).
 *
 * This module holds only the parts both `printing.ts` and `automation.ts` need,
 * which is what keeps those two from importing each other.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const ONE = 1;

export const CHANGEOVER_BEHAVIOR = 'auto-changeover';

export function changeoverAutomationDefs(content: Content): readonly AutomationDef[] {
  return content.automation.filter((def) => def.behavior === CHANGEOVER_BEHAVIOR);
}

/**
 * Is the rota turning? Installed *and* switched on: flipping the automation off
 * freezes every queue exactly where it stands, which is the point of the switch.
 */
export function isQueueRunning(state: GameState, content: Content): boolean {
  return changeoverAutomationDefs(content).some((def) => {
    const owned = state.automation[def.id];
    return owned !== undefined && owned.level > NONE && owned.enabled;
  });
}

/** Grams of the incoming material the rota insists on before it rotates. */
export function queueStockFloor(state: GameState, content: Content): number {
  let floor = NONE;
  for (const def of changeoverAutomationDefs(content)) {
    const owned = state.automation[def.id];
    if (owned !== undefined && owned.level > NONE) {
      floor = Math.max(floor, owned.threshold);
    }
  }
  return floor;
}

export function currentQueueEntry(slot: SlotState): SlotQueueEntry | null {
  return slot.queue.at(slot.queueIndex) ?? null;
}

/** The entry after the loaded one, wrapping around; `null` for an empty rota. */
export function nextQueueEntry(slot: SlotState): SlotQueueEntry | null {
  if (slot.queue.length <= NONE) {
    return null;
  }
  return slot.queue.at((slot.queueIndex + ONE) % slot.queue.length) ?? null;
}

/**
 * Has the loaded entry printed its share? An entry asking for zero batches is
 * treated as "one", so a malformed rota rotates rather than jamming.
 */
export function queueEntryDone(slot: SlotState): boolean {
  const entry = currentQueueEntry(slot);
  if (entry === null) {
    return false;
  }
  return slot.queueBatches >= Math.max(entry.batches, ONE);
}

export type QueueRejection = 'unknown-target' | 'locked' | 'missing-prerequisite';

/**
 * A rota may only name materials and objects that exist. Whether the *player*
 * has unlocked them is checked by the reducer against the same rules a manual
 * `SET_SLOT_CONFIG` obeys, so a queue can never smuggle in a locked material.
 */
export function queueEntriesResolve(content: Content, entries: readonly SlotQueueEntry[]): boolean {
  const materials = indexById(content.materials);
  const objects = indexById(content.objects);
  return entries.every(
    (entry) =>
      materials.get(entry.materialId) !== undefined && objects.get(entry.objectId) !== undefined,
  );
}
