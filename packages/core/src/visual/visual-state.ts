import type { Content } from '../content/schema.js';
import type { GameState, SlotState } from '../state/game-state.js';
import { assemblyPieces, isPieceReady, nextPiece } from '../systems/assembly.js';
import { getPhase } from '../systems/phases.js';
import { bestPrinterTier, resolveSlotConfig, runProgress } from '../systems/printing.js';
import type { AssemblyVisual, LedgerVisual, SlotVisual, VisualState } from './schema.js';
import { VISUAL_STATE_VERSION } from './schema.js';

/**
 * `toVisualState` — the Projection (Adapter) of spec §15, and the *only* thing
 * a renderer is allowed to read. Everything the workshop draws is derived here
 * from `GameState` + `Content`, so a renderer never needs a content table, a
 * clock or a rule of its own.
 *
 * The shape it produces is frozen and versioned in `./schema.ts`.
 */

const NONE = 0;

/**
 * Deterministic per-slot animation offset — no rng, no clock (spec §13).
 * `total` is the slot count and this is only ever called from inside a map over
 * those slots, so it cannot be zero; no guard, because a guard nothing can
 * reach is a branch no test can ever justify.
 */
function phaseOffsetOf(index: number, total: number): number {
  return index / total;
}

function toSlotVisual(
  slot: SlotState,
  content: Content,
  index: number,
  slotCount: number,
  machineTier: number,
): SlotVisual {
  const config = resolveSlotConfig(content, slot);
  const staffed = slot.printerCount > NONE;
  // "Occupied" means the bay is actually working: a config *and* a machine.
  // A staffed bay with no config still shows its printer — the player built it
  // and it should not vanish while they decide what to load into it.
  const occupied = config !== null && staffed;
  return {
    slotId: slot.id,
    index,
    materialId: config?.material.id ?? null,
    materialName: config?.material.name ?? null,
    objectId: config?.object.id ?? null,
    objectName: config?.object.name ?? null,
    machineTier: staffed ? machineTier : NONE,
    printerCount: slot.printerCount,
    phaseOffset: phaseOffsetOf(index, slotCount),
    occupied,
    running: slot.run !== null,
    progress: slot.run === null ? NONE : runProgress(slot.run),
    batch: slot.run?.batch ?? NONE,
  };
}

function toAssemblyVisual(state: GameState, content: Content): AssemblyVisual {
  const pieces = assemblyPieces(content);
  const piece = nextPiece(state.assembly, content);
  const attached = state.assembly.attachedPieceIds.length;
  return {
    attachedPieceIds: state.assembly.attachedPieceIds,
    totalPieces: pieces.length,
    nextPieceId: piece?.id ?? null,
    nextPieceName: piece?.name ?? null,
    cooldownMs: state.assembly.cooldownMs,
    ready: piece !== null && isPieceReady(state.assembly),
    // `StartFileSchema` requires at least one assembly piece, so the divisor
    // cannot be zero and there is nothing to guard against.
    progress: attached / pieces.length,
    complete: piece === null,
  };
}

function toLedgerVisual(state: GameState): LedgerVisual {
  return {
    parts: state.resources.parts,
    money: state.resources.money,
    scrap: state.resources.scrap,
    filamentGrams: state.filamentGrams,
  };
}

export function toVisualState(state: GameState, content: Content): VisualState {
  const machineTier = bestPrinterTier(state, content);
  return {
    version: VISUAL_STATE_VERSION,
    phaseId: state.phaseId,
    phaseName: getPhase(content.pacing.phases, state.phaseId).name,
    simTimeMs: state.simTimeMs,
    slotCapacity: content.start.maxSlotCount,
    // Every slot is projected, empty ones included: the "empty slot = faint
    // outline" rule (spec §4) is the renderer drawing data, not inventing it.
    slots: state.slots.map((slot, index) =>
      toSlotVisual(slot, content, index, state.slots.length, machineTier),
    ),
    assembly: toAssemblyVisual(state, content),
    ledger: toLedgerVisual(state),
  };
}

/** Slots the player can actually see working — a convenience for HUD callers. */
export function occupiedSlots(visual: VisualState): readonly SlotVisual[] {
  return visual.slots.filter((slot) => slot.occupied);
}
