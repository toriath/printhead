import type { Content } from '../content/schema.js';
import type { GameState, SlotState } from '../state/game-state.js';
import { chosenFork } from './forks.js';

/**
 * Fleet allocation (spec §4/§5B): "printers are **assigned to slots**; all
 * printers in a slot print its config", and the core decision of the mid-game
 * is *how do I spread the fleet across the bays?*
 *
 * Machines are a pool of identical units — `state.printers` says how many exist
 * and each slot says how many of them work there — so allocation is pure
 * bookkeeping with one invariant that must never break:
 *
 *     Σ slot.printerCount  ===  Σ state.printers[*]
 *
 * Everything in this file is written to preserve it: a move takes from one bay
 * exactly what it gives to another, and refuses rather than rounds.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;

export function assignedPrinters(state: GameState): number {
  let total = NONE;
  for (const slot of state.slots) {
    total += slot.printerCount;
  }
  return total;
}

/**
 * Machines one bay can hold. This is what gives a config slot its price tag:
 * without a cap a second bay would buy the player nothing but a second recipe,
 * because a batch's duration does not depend on how many printers run it — so
 * splitting the same fleet over two bays would produce exactly the same parts
 * per minute. With a cap, bays *are* fleet capacity, and spec §4's "how do I
 * allocate my fleet across slots?" is a question with an answer.
 *
 * A fork may override it, which is the whole mechanical content of "one giant
 * printer" (spec §5B).
 */
export function printersPerSlot(state: GameState, content: Content): number {
  return chosenFork(state, content)?.printersPerSlot ?? content.start.printersPerSlot;
}

/** Room left in a bay for another machine. */
export function slotRoom(state: GameState, content: Content, slot: SlotState): number {
  return Math.max(printersPerSlot(state, content) - slot.printerCount, NONE);
}

/** Total machines the workshop can field right now, across every bay it uses. */
export function fleetCapacity(state: GameState, content: Content, activeSlots: number): number {
  return printersPerSlot(state, content) * activeSlots;
}

/** The first bay with room for another machine, or `null` when the rack is full. */
export function slotWithRoom(state: GameState, content: Content): SlotState | null {
  return state.slots.find((slot) => slotRoom(state, content, slot) > NONE) ?? null;
}

export type AssignRejection =
  | 'unknown-target'
  | 'nothing-to-do'
  | 'insufficient-resources'
  | 'slot-full';

/**
 * Take `count` machines off a bay.
 *
 * A batch in flight had its filament consumed for the printers that started it,
 * so pulling machines out mid-run *shrinks the batch* rather than refunding it:
 * the run finishes with however many printers are left standing over it. That
 * keeps "all printers in a slot print its config" literally true at every
 * instant, and it makes reallocating during a long print a real cost rather
 * than a free optimisation.
 */
function withdraw(slot: SlotState, count: number): SlotState {
  const remaining = slot.printerCount - count;
  const run =
    slot.run === null
      ? null
      : remaining > NONE
        ? { ...slot.run, batch: Math.min(slot.run.batch, remaining) }
        : null;
  return { ...slot, printerCount: remaining, run };
}

export interface FleetMove {
  readonly state: GameState;
  readonly moved: number;
  readonly fromSlotId: string;
  readonly toSlotId: string;
}

/**
 * Move machines between two bays. `count` is clamped to what the source has, so
 * a UI may ask for "all of them" without first counting.
 */
export function assignPrinters(
  state: GameState,
  content: Content,
  fromSlotId: string,
  toSlotId: string,
  count: number,
): FleetMove | AssignRejection {
  if (fromSlotId === toSlotId) {
    return 'nothing-to-do';
  }
  const fromIndex = state.slots.findIndex((slot) => slot.id === fromSlotId);
  const toIndex = state.slots.findIndex((slot) => slot.id === toSlotId);
  const from = state.slots.at(fromIndex);
  const to = state.slots.at(toIndex);
  if (fromIndex < NONE || toIndex < NONE || from === undefined || to === undefined) {
    return 'unknown-target';
  }
  if (!Number.isFinite(count) || count <= NONE) {
    return 'nothing-to-do';
  }
  const room = slotRoom(state, content, to);
  if (room <= NONE) {
    return 'slot-full';
  }
  const moved = Math.min(Math.floor(count), from.printerCount, room);
  if (moved <= NONE) {
    return 'insufficient-resources';
  }
  const slots = state.slots.map((slot, index) => {
    if (index === fromIndex) {
      return withdraw(slot, moved);
    }
    if (index === toIndex) {
      return { ...slot, printerCount: slot.printerCount + moved };
    }
    return slot;
  });
  return { state: { ...state, slots }, moved, fromSlotId, toSlotId };
}
