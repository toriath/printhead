import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import type { ActionRejectedReason } from '../events/types.js';
import { attachAssemblyPiece, tickAssembly } from '../systems/assembly.js';
import {
  grantPrinter,
  purchaseFilament,
  purchasePrinter,
  sellPartsFrom,
} from '../systems/economy.js';
import { getPhase, isActionAllowed, isPhaseReached, nextPhaseId } from '../systems/phases.js';
import { beginRun, slotIndexOf, tickSlots, withSlot } from '../systems/printing.js';
import { meetsRequirements } from '../systems/requirements.js';
import type { Action, GatedAction } from './actions.js';
import type { GameState, ReduceContext } from './game-state.js';

/**
 * The single pure reducer (spec §15). No I/O, no clock, no randomness beyond
 * what `ctx` injects; identical `(state, action, ctx)` always yields an
 * identical next state. Domain events go out through `ctx.emit`, which keeps
 * the state transition itself side-effect free and replayable.
 *
 * This file orchestrates; every rule and every number lives in `systems/` and
 * `content/` respectively.
 */

/** Actions the phase FSM never gates: the clock and the FSM's own transition. */
const UNGATED: readonly Action['type'][] = ['TICK', 'ADVANCE_PHASE'];

function isGated(action: Action): action is GatedAction {
  return !UNGATED.includes(action.type);
}

function reject(
  ctx: ReduceContext,
  state: GameState,
  actionType: string,
  reason: ActionRejectedReason,
): GameState {
  ctx.emit?.({ type: 'ACTION_REJECTED', simTimeMs: state.simTimeMs, actionType, reason });
  return state;
}

export function reduce(state: GameState, action: Action, ctx: ReduceContext): GameState {
  if (isGated(action) && !isActionAllowed(ctx.content.pacing.phases, state.phaseId, action.type)) {
    return reject(ctx, state, action.type, 'phase-gated');
  }
  switch (action.type) {
    case 'TICK':
      return applyTick(state, action.simDtMs, ctx);
    case 'ADVANCE_PHASE':
      return advanceOnce(state, ctx) ?? reject(ctx, state, action.type, 'not-ready');
    case 'ATTACH_PIECE':
      return applyAttachPiece(state, action.pieceId, ctx);
    case 'SET_SLOT_CONFIG':
      return applySetSlotConfig(state, action.slotId, action.materialId, action.objectId, ctx);
    case 'START_PRINT':
      return applyStartPrint(state, action.slotId, ctx);
    case 'SELL_PARTS':
      return applySellParts(state, action.count, ctx);
    case 'BUY_FILAMENT':
      return applyBuyFilament(state, action.materialId, action.grams, ctx);
    case 'BUY_PRINTER':
      return applyBuyPrinter(state, action.printerId, action.slotId, ctx);
  }
}

// --- TICK -------------------------------------------------------------------

function applyTick(state: GameState, simDtMs: number, ctx: ReduceContext): GameState {
  if (!Number.isFinite(simDtMs) || simDtMs < 0) {
    throw new RangeError(`TICK simDtMs must be non-negative, received ${simDtMs}`);
  }
  const clocked: GameState = {
    ...state,
    simTimeMs: state.simTimeMs + simDtMs,
    tickCount: state.tickCount + 1,
    assembly: tickAssembly(state.assembly, simDtMs),
  };
  return advanceWhileReady(tickSlots(clocked, ctx.content, simDtMs, ctx.emit), ctx);
}

// --- phase FSM --------------------------------------------------------------

/** One FSM step, or `null` when the gate is closed / the game has ended. */
function advanceOnce(state: GameState, ctx: ReduceContext): GameState | null {
  const phase = getPhase(ctx.content.pacing.phases, state.phaseId);
  if (!meetsRequirements(state, ctx.content, phase.advanceWhen)) {
    return null;
  }
  const toPhaseId = nextPhaseId(ctx.content.pacing.phases, state.phaseId);
  if (toPhaseId === null) {
    return null;
  }
  ctx.emit?.({
    type: 'PHASE_ADVANCED',
    simTimeMs: state.simTimeMs,
    fromPhaseId: state.phaseId,
    toPhaseId,
  });
  return { ...state, phaseId: toPhaseId, phaseEnteredAtMs: state.simTimeMs };
}

/** Phases are data-gated states; a tick that satisfies a gate walks through it. */
function advanceWhileReady(state: GameState, ctx: ReduceContext): GameState {
  let current = state;
  for (let step = 0; step < ctx.content.pacing.phases.length; step += 1) {
    const advanced = advanceOnce(current, ctx);
    if (advanced === null) {
      return current;
    }
    current = advanced;
  }
  return current;
}

// --- intro assembly ---------------------------------------------------------

function applyAttachPiece(state: GameState, pieceId: string, ctx: ReduceContext): GameState {
  const result = attachAssemblyPiece(state.assembly, ctx.content, pieceId);
  if (!result.ok) {
    return reject(ctx, state, 'ATTACH_PIECE', result.reason);
  }
  const attached: GameState = { ...state, assembly: result.assembly };
  ctx.emit?.({
    type: 'PIECE_ATTACHED',
    simTimeMs: state.simTimeMs,
    pieceId,
    attachedCount: result.assembly.attachedPieceIds.length,
    totalPieces: ctx.content.start.assemblyPieces.length,
  });
  if (result.assembly.attachedPieceIds.length < ctx.content.start.assemblyPieces.length) {
    return attached;
  }
  return completeAssembly(attached, ctx);
}

/** The last piece clicks in: printer #1 exists and is assigned to the first slot. */
function completeAssembly(state: GameState, ctx: ReduceContext): GameState {
  const printerId = ctx.content.start.printerId;
  const granted = grantPrinter(state, printerId);
  const firstSlot = granted.state.slots.at(0);
  const assigned =
    firstSlot === undefined
      ? granted.state
      : withSlot(granted.state, 0, {
          ...firstSlot,
          printerCount: firstSlot.printerCount + 1,
        });
  ctx.emit?.({ type: 'ASSEMBLY_COMPLETED', simTimeMs: state.simTimeMs, printerId });
  ctx.emit?.({
    type: 'PRINTER_BUILT',
    simTimeMs: state.simTimeMs,
    printerId,
    slotId: firstSlot?.id ?? '',
    owned: granted.owned,
    paid: granted.cost.amount,
  });
  return assigned;
}

// --- slots ------------------------------------------------------------------

function applySetSlotConfig(
  state: GameState,
  slotId: string,
  materialId: string,
  objectId: string,
  ctx: ReduceContext,
): GameState {
  const index = slotIndexOf(state, slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'unknown-target');
  }
  const availability = configAvailability(ctx.content, materialId, objectId, state.phaseId);
  if (availability !== null) {
    return reject(ctx, state, 'SET_SLOT_CONFIG', availability);
  }
  if (slot.run !== null) {
    // Changeover on a running slot costs time and filament — that is M3.
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'slot-busy');
  }
  ctx.emit?.({
    type: 'SLOT_CONFIGURED',
    simTimeMs: state.simTimeMs,
    slotId,
    materialId,
    objectId,
  });
  return withSlot(state, index, { ...slot, materialId, objectId });
}

/**
 * Why a `{ material, object }` pair cannot be loaded, or `null` if it can.
 *
 * "That id does not exist" and "you have not unlocked it yet" are different
 * facts: the first is a bug in the caller, the second is the game working as
 * designed. Reporting both as `unknown-target` would hide real content typos
 * behind an expected rejection.
 */
function configAvailability(
  content: Content,
  materialId: string,
  objectId: string,
  phaseId: string,
): ActionRejectedReason | null {
  const material = indexById(content.materials).get(materialId);
  const object = indexById(content.objects).get(objectId);
  if (material === undefined || object === undefined) {
    return 'unknown-target';
  }
  const phases = content.pacing.phases;
  const unlocked =
    isPhaseReached(phases, phaseId, material.unlockPhaseId) &&
    isPhaseReached(phases, phaseId, object.unlockPhaseId);
  return unlocked ? null : 'locked';
}

function applyStartPrint(state: GameState, slotId: string, ctx: ReduceContext): GameState {
  const index = slotIndexOf(state, slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'START_PRINT', 'unknown-target');
  }
  if (slot.run !== null) {
    return reject(ctx, state, 'START_PRINT', 'slot-busy');
  }
  const started = beginRun(state, ctx.content, index, 0, ctx.emit);
  if (started === null) {
    return reject(ctx, state, 'START_PRINT', 'insufficient-resources');
  }
  return started;
}

// --- economy ----------------------------------------------------------------

function applySellParts(state: GameState, count: number | null, ctx: ReduceContext): GameState {
  const sale = sellPartsFrom(state, count);
  if (sale === null) {
    return reject(ctx, state, 'SELL_PARTS', 'nothing-to-do');
  }
  ctx.emit?.({
    type: 'PART_SOLD',
    simTimeMs: state.simTimeMs,
    parts: sale.parts,
    money: sale.money,
  });
  return sale.state;
}

function applyBuyFilament(
  state: GameState,
  materialId: string,
  grams: number,
  ctx: ReduceContext,
): GameState {
  if (indexById(ctx.content.materials).get(materialId) === undefined) {
    return reject(ctx, state, 'BUY_FILAMENT', 'unknown-target');
  }
  const purchase = purchaseFilament(state, ctx.content, materialId, grams);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_FILAMENT', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'FILAMENT_PURCHASED',
    simTimeMs: state.simTimeMs,
    materialId,
    grams,
    money: purchase.cost,
  });
  return purchase.state;
}

function applyBuyPrinter(
  state: GameState,
  printerId: string,
  slotId: string,
  ctx: ReduceContext,
): GameState {
  const index = slotIndexOf(state, slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'BUY_PRINTER', 'unknown-target');
  }
  if (indexById(ctx.content.printers).get(printerId) === undefined) {
    return reject(ctx, state, 'BUY_PRINTER', 'unknown-target');
  }
  const curves = createCurveRegistry(ctx.content.curves);
  const purchase = purchasePrinter(state, ctx.content, curves, printerId);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_PRINTER', 'insufficient-resources');
  }
  const assignedSlot = purchase.state.slots.at(index);
  const assigned =
    assignedSlot === undefined
      ? purchase.state
      : withSlot(purchase.state, index, {
          ...assignedSlot,
          printerCount: assignedSlot.printerCount + 1,
        });
  ctx.emit?.({
    type: 'PRINTER_BUILT',
    simTimeMs: state.simTimeMs,
    printerId,
    slotId,
    owned: purchase.owned,
    paid: purchase.cost.amount,
  });
  return assigned;
}
