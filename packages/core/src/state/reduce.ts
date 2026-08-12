import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import type { ActionRejectedReason } from '../events/types.js';
import { attachAssemblyPiece, tickAssembly } from '../systems/assembly.js';
import {
  automationAvailability,
  configureAutomation,
  purchaseAutomation,
  tickAutomation,
} from '../systems/automation.js';
import { grantPrinter, purchasePrinter, sellPartsFrom } from '../systems/economy.js';
import { recycleScrapInto } from '../systems/failure.js';
import { purchaseFilament, sellFilamentToMarket, tickMarket } from '../systems/market.js';
import { getPhase, isActionAllowed, isPhaseReached, nextPhaseId } from '../systems/phases.js';
import {
  applyChangeover,
  beginRun,
  resolveSlotConfig,
  slotIndexOf,
  tickSlots,
  withSlot,
} from '../systems/printing.js';
import { meetsRequirements } from '../systems/requirements.js';
import {
  computeModifiers,
  isMaterialAvailable,
  purchaseUpgrade,
  upgradeAvailability,
} from '../systems/upgrades.js';
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
    case 'SELL_FILAMENT':
      return applySellFilament(state, action.materialId, action.grams, ctx);
    case 'BUY_PRINTER':
      return applyBuyPrinter(state, action.printerId, action.slotId, ctx);
    case 'BUY_UPGRADE':
      return applyBuyUpgrade(state, action.upgradeId, ctx);
    case 'BUY_AUTOMATION':
      return applyBuyAutomation(state, action.automationId, ctx);
    case 'SET_AUTOMATION':
      return applySetAutomation(state, action, ctx);
    case 'RECYCLE_SCRAP':
      return applyRecycleScrap(state, action.materialId, action.grams, ctx);
  }
}

// --- TICK -------------------------------------------------------------------

/**
 * One fixed timestep. The order is fixed and load-bearing, because it is what
 * makes a replay reproducible:
 *
 *   assembly → printers → market drift → automation → phase FSM
 *
 * Automation runs *after* the market has drifted and the printers have paid
 * out, so a bot inside the machine sees exactly the world a player checking in
 * at that instant would see. The FSM runs last, so a phase can only advance on
 * a fully settled state.
 */
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
  const printed = tickSlots(clocked, ctx.content, simDtMs, ctx.emit);
  const traded = tickMarket(printed, ctx.content, simDtMs);
  const automated = tickAutomation(traded, ctx.content, simDtMs, ctx.emit);
  return advanceWhileReady(automated, ctx);
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
  const availability = configAvailability(state, ctx.content, materialId, objectId);
  if (availability !== null) {
    return reject(ctx, state, 'SET_SLOT_CONFIG', availability);
  }
  if (slot.changeoverMs > 0) {
    // A purge cannot be interrupted; the nozzle is already half-flushed.
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'slot-busy');
  }
  const config = resolveSlotConfig(ctx.content, { ...slot, materialId, objectId });
  if (config === null) {
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'unknown-target');
  }
  /*
   * A run in flight is *abandoned*, not refused.
   *
   * Refusing looked right until the slot loop was actually played: a printing
   * slot re-arms itself the instant a batch lands, so `run === null` is a state
   * the player essentially never catches, and "you may only reconfigure an idle
   * slot" quietly meant "you may never reconfigure". Abandoning has a real
   * price — the batch's filament was consumed at the start of the run and is
   * simply gone — which is exactly the friction spec §3 asks a changeover to
   * carry, and it leaves the decision with the player instead of the scheduler.
   */
  const abandonedBatch = slot.run?.batch ?? 0;
  const idle = withSlot(state, index, { ...slot, run: null });
  const { state: purged, changeover } = applyChangeover(idle, { ...slot, run: null }, config);
  ctx.emit?.({
    type: 'SLOT_CONFIGURED',
    simTimeMs: state.simTimeMs,
    slotId,
    materialId,
    objectId,
    downtimeMs: changeover.downtimeMs,
    purgedGrams: changeover.purgedGrams,
    abandonedBatch,
  });
  return withSlot(purged, index, changeover.slot);
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
  state: GameState,
  content: Content,
  materialId: string,
  objectId: string,
): ActionRejectedReason | null {
  const material = indexById(content.materials).get(materialId);
  const object = indexById(content.objects).get(objectId);
  if (material === undefined || object === undefined) {
    return 'unknown-target';
  }
  const unlocked =
    // Materials are gated by the machine tree as well as by the phase (spec §3).
    isMaterialAvailable(state, content, materialId) &&
    isPhaseReached(content.pacing.phases, state.phaseId, object.unlockPhaseId);
  return unlocked ? null : 'locked';
}

function applyStartPrint(state: GameState, slotId: string, ctx: ReduceContext): GameState {
  const index = slotIndexOf(state, slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'START_PRINT', 'unknown-target');
  }
  if (slot.run !== null || slot.changeoverMs > 0) {
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
  if (!isMaterialAvailable(state, ctx.content, materialId)) {
    return reject(ctx, state, 'BUY_FILAMENT', 'locked');
  }
  const purchase = purchaseFilament(state, ctx.content, materialId, grams);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_FILAMENT', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'FILAMENT_PURCHASED',
    simTimeMs: state.simTimeMs,
    materialId,
    grams: purchase.grams,
    money: purchase.money,
  });
  return purchase.state;
}

function applySellFilament(
  state: GameState,
  materialId: string,
  grams: number,
  ctx: ReduceContext,
): GameState {
  const material = indexById(ctx.content.materials).get(materialId);
  if (material === undefined) {
    return reject(ctx, state, 'SELL_FILAMENT', 'unknown-target');
  }
  if (!ctx.content.market.listings.some((listing) => listing.materialId === materialId)) {
    return reject(ctx, state, 'SELL_FILAMENT', 'not-tradeable');
  }
  const sale = sellFilamentToMarket(state, ctx.content, materialId, grams);
  if (sale === null) {
    return reject(ctx, state, 'SELL_FILAMENT', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'FILAMENT_SOLD',
    simTimeMs: state.simTimeMs,
    materialId,
    grams: sale.grams,
    money: sale.money,
    pricePerGram: sale.pricePerGram,
  });
  return sale.state;
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

// --- upgrades and automation ------------------------------------------------

function applyBuyUpgrade(state: GameState, upgradeId: string, ctx: ReduceContext): GameState {
  const blocked = upgradeAvailability(state, ctx.content, upgradeId);
  if (blocked !== null) {
    return reject(ctx, state, 'BUY_UPGRADE', blocked);
  }
  const curves = createCurveRegistry(ctx.content.curves);
  const purchase = purchaseUpgrade(state, ctx.content, curves, upgradeId);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_UPGRADE', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'UPGRADE_INSTALLED',
    simTimeMs: state.simTimeMs,
    upgradeId,
    level: purchase.level,
    paid: purchase.cost.amount,
  });
  return purchase.state;
}

function applyBuyAutomation(state: GameState, automationId: string, ctx: ReduceContext): GameState {
  const blocked = automationAvailability(state, ctx.content, automationId);
  if (blocked !== null) {
    return reject(ctx, state, 'BUY_AUTOMATION', blocked);
  }
  const curves = createCurveRegistry(ctx.content.curves);
  const purchase = purchaseAutomation(state, ctx.content, curves, automationId);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_AUTOMATION', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'AUTOMATION_INSTALLED',
    simTimeMs: state.simTimeMs,
    automationId,
    level: purchase.level,
    paid: purchase.cost.amount,
  });
  return purchase.state;
}

function applySetAutomation(
  state: GameState,
  action: Extract<Action, { type: 'SET_AUTOMATION' }>,
  ctx: ReduceContext,
): GameState {
  const configured = configureAutomation(state, action.automationId, {
    ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
    ...(action.threshold === undefined ? {} : { threshold: action.threshold }),
  });
  if (configured === null) {
    return reject(ctx, state, 'SET_AUTOMATION', 'unknown-target');
  }
  const owned = configured.automation[action.automationId];
  ctx.emit?.({
    type: 'AUTOMATION_CONFIGURED',
    simTimeMs: state.simTimeMs,
    automationId: action.automationId,
    enabled: owned?.enabled ?? false,
    threshold: owned?.threshold ?? 0,
  });
  return configured;
}

function applyRecycleScrap(
  state: GameState,
  materialId: string,
  grams: number | null,
  ctx: ReduceContext,
): GameState {
  const modifiers = computeModifiers(state, ctx.content);
  const result = recycleScrapInto(state, ctx.content, modifiers, materialId, grams);
  if (typeof result === 'string') {
    return reject(ctx, state, 'RECYCLE_SCRAP', result);
  }
  ctx.emit?.({
    type: 'SCRAP_RECYCLED',
    simTimeMs: state.simTimeMs,
    materialId,
    scrapGrams: result.scrapGrams,
    filamentGrams: result.filamentGrams,
  });
  return result.state;
}
