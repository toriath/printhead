import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { curveRegistryFor } from '../curves/evaluate.js';
import type { ActionRejectedReason } from '../events/types.js';
import { attachAssemblyPiece, isPieceReady, nextPiece, tickAssembly } from '../systems/assembly.js';
import {
  automationAvailability,
  automationLevel,
  configureAutomation,
  purchaseAutomation,
  tickAutomation,
} from '../systems/automation.js';
import { designAvailability, hasDesign, startDesignDraft, tickStudio } from '../systems/designs.js';
import {
  grantPrinter,
  purchasePrinter,
  sellPartsFrom,
  sellProductsFrom,
} from '../systems/economy.js';
import {
  beginFabricatorPrint,
  fabricatorAvailability,
  fabricatorDurationMs,
  isFabricating,
  newGamePlusAvailability,
  sectionAvailability,
  startNewGamePlus,
  startSection,
  tickFabricator,
  tickFactory,
} from '../systems/endgame.js';
import { isEndingComplete } from '../systems/ending.js';
import { recycleScrapInto } from '../systems/failure.js';
import { assignPrinters, slotRoom } from '../systems/fleet.js';
import { commitFork, forkAvailability } from '../systems/forks.js';
import { purchaseFilament, sellFilamentToMarket, tickMarket } from '../systems/market.js';
import { getPhase, isActionAllowed, isPhaseReached, nextPhaseId } from '../systems/phases.js';
import {
  meltDown,
  moneyPrinterAvailability,
  prestigeAvailability,
  purchaseMoneyPrinter,
  tickMoneyPrinting,
} from '../systems/prestige.js';
import {
  applyChangeover,
  beginRun,
  resolveSlotConfig,
  slotIndexOf,
  tickSlots,
  withSlot,
} from '../systems/printing.js';
import { changeoverAutomationDefs, queueEntriesResolve } from '../systems/queue.js';
import { meetsRequirements, totalDesignMinutes } from '../systems/requirements.js';
import { purchaseSlot, slotUnlockAvailability } from '../systems/slots.js';
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
    case 'BUY_SLOT':
      return applyBuySlot(state, action.unlockId, ctx);
    case 'ASSIGN_PRINTER':
      return applyAssignPrinter(state, action, ctx);
    case 'SET_SLOT_QUEUE':
      return applySetSlotQueue(state, action, ctx);
    case 'CHOOSE_FORK':
      return applyChooseFork(state, action.forkId, ctx);
    case 'CREATE_DESIGN':
      return applyCreateDesign(state, action.designId, ctx);
    case 'SET_SLOT_DESIGN':
      return applySetSlotDesign(state, action.slotId, action.designId, ctx);
    case 'SELL_PRODUCTS':
      return applySellProducts(state, action.count, ctx);
    case 'PRESTIGE':
      return applyPrestige(state, ctx);
    case 'BUY_MONEY_PRINTER':
      return applyBuyMoneyPrinter(state, action.moneyPrinterId, ctx);
    case 'PRINT_SECTION':
      return applyPrintSection(state, ctx);
    case 'START_FABRICATOR':
      return applyStartFabricator(state, ctx);
    case 'NEW_GAME_PLUS':
      return applyNewGamePlus(state, action.modifierIds, ctx);
  }
}

// --- TICK -------------------------------------------------------------------

/**
 * One fixed timestep. The order is fixed and load-bearing, because it is what
 * makes a replay reproducible:
 *
 *   assembly → studio → printers → market drift → money press → factory →
 *   fabricator → automation → FSM
 *
 * Automation runs *after* the market has drifted and the printers have paid
 * out, so a bot inside the machine sees exactly the world a player checking in
 * at that instant would see. The FSM runs last, so a phase can only advance on
 * a fully settled state — including on the tick where the credits finish.
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
  const rebuilt = selfAssemble(clocked, ctx);
  const drafted = tickDesignStudio(rebuilt, simDtMs, ctx);
  const printed = tickSlots(drafted, ctx.content, simDtMs, ctx.emit);
  const traded = tickMarket(printed, ctx.content, simDtMs);
  const curves = curveRegistryFor(ctx.content.curves);
  const minted = tickMoneyPrinting(traded, ctx.content, simDtMs, curves);
  const modifiers = computeModifiers(minted, ctx.content);
  const manufactured = tickFactory(minted, ctx.content, simDtMs, modifiers, ctx.emit);
  const built = tickTheFinalPrint(state, manufactured, simDtMs, ctx);
  const automated = tickAutomation(built, ctx.content, simDtMs, ctx.emit);
  return advanceWhileReady(automated, ctx);
}

/**
 * The intro replay of spec §6 phase 4. After the first melt-down the workshop
 * knows how to build itself, so the next piece clips on by itself the moment
 * its bench work is done — through `applyAttachPiece`, the very same path a
 * clicking player takes, so printer #1 is granted and the events fire exactly
 * as they did the first time. One piece per tick, because the attach resets the
 * cooldown and the next piece has to wait its turn like any other.
 *
 * It calls the handler rather than re-entering `reduce`, and that is the point:
 * `ATTACH_PIECE` belongs to the intro phase's `allowedActions`, while the
 * replay happens in phase 4. Going through the gate would reject every piece.
 * The shell agrees — `buildControlModel` offers no Attach button outside the
 * intro — so nothing is being routed around except the phase FSM's opinion
 * about an action the *player* is no longer taking.
 */
function selfAssemble(state: GameState, ctx: ReduceContext): GameState {
  if (!state.selfAssembling || !isPieceReady(state.assembly)) {
    return state;
  }
  const piece = nextPiece(state.assembly, ctx.content);
  return piece === null ? state : applyAttachPiece(state, piece.id, ctx);
}

/**
 * Advance the Universal Fabricator and announce the moment the credits stop
 * rolling (spec §6 phase 6). `GAME_ENDED` is emitted exactly once — on the tick
 * the sequence crosses its last stage — because the ending is derived from the
 * clock and would otherwise be "true" forever after.
 */
function tickTheFinalPrint(
  before: GameState,
  state: GameState,
  simDtMs: number,
  ctx: ReduceContext,
): GameState {
  /*
   * `before` is the state as it was *at the start of the tick*, and it has to
   * be: the ending is derived from the clock, and by the time the systems run
   * the clock has already moved. Asking the post-tick state whether the credits
   * had finished answers "yes" on the very tick they finish, and the
   * announcement would never be made.
   */
  const wasComplete = isEndingComplete(before, ctx.content);
  const built = tickFabricator(state, ctx.content, simDtMs, ctx.emit);
  if (!wasComplete && isEndingComplete(built, ctx.content)) {
    ctx.emit?.({
      type: 'GAME_ENDED',
      simTimeMs: built.simTimeMs,
      totalDesignMinutes: totalDesignMinutes(built),
    });
  }
  return built;
}

/** Advance the studio bench; a finished draft becomes an owned Design. */
function tickDesignStudio(state: GameState, simDtMs: number, ctx: ReduceContext): GameState {
  const result = tickStudio(state, simDtMs);
  if (!('designId' in result)) {
    return result;
  }
  ctx.emit?.({
    type: 'DESIGN_CREATED',
    simTimeMs: state.simTimeMs,
    designId: result.designId,
    designsOwned: Object.keys(result.state.designs).length,
  });
  return result.state;
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
  if (isFabricating(state)) {
    // Every bay is committed to the final print (spec §4).
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'slot-busy');
  }
  if (slot.changeoverMs > 0) {
    // A purge cannot be interrupted; the nozzle is already half-flushed.
    return reject(ctx, state, 'SET_SLOT_CONFIG', 'slot-busy');
  }
  // Loading a stock object takes the bay out of Design mode (spec §5D).
  const config = resolveSlotConfig(ctx.content, { ...slot, materialId, objectId, designId: null });
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
    recipeId: config.recipeId,
    downtimeMs: changeover.downtimeMs,
    purgedGrams: changeover.purgedGrams,
    abandonedBatch,
  });
  return withSlot(purged, index, changeover.slot);
}

/**
 * Point a bay at a Design (spec §5D). It is the same load as `SET_SLOT_CONFIG`
 * — same changeover cost, same abandoned batch — with the material chosen for
 * the player, because a Design says what it must be printed in.
 */
function applySetSlotDesign(
  state: GameState,
  slotId: string,
  designId: string,
  ctx: ReduceContext,
): GameState {
  const index = slotIndexOf(state, slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'unknown-target');
  }
  const def = indexById(ctx.content.designs).get(designId);
  if (def === undefined) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'unknown-target');
  }
  if (!hasDesign(state, designId)) {
    // The design exists in content but the studio has not drafted it.
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'missing-prerequisite');
  }
  if (!isMaterialAvailable(state, ctx.content, def.requiredMaterialId)) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'locked');
  }
  if (isFabricating(state)) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'slot-busy');
  }
  if (slot.changeoverMs > 0) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'slot-busy');
  }
  const config = resolveSlotConfig(ctx.content, {
    ...slot,
    materialId: def.requiredMaterialId,
    objectId: null,
    designId,
  });
  if (config === null) {
    return reject(ctx, state, 'SET_SLOT_DESIGN', 'unknown-target');
  }
  const abandonedBatch = slot.run?.batch ?? 0;
  const idle = withSlot(state, index, { ...slot, run: null });
  const { state: purged, changeover } = applyChangeover(idle, { ...slot, run: null }, config);
  ctx.emit?.({
    type: 'SLOT_CONFIGURED',
    simTimeMs: state.simTimeMs,
    slotId,
    materialId: def.requiredMaterialId,
    recipeId: config.recipeId,
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
  if (slot.run !== null || slot.changeoverMs > 0 || isFabricating(state)) {
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

function applySellProducts(state: GameState, count: number | null, ctx: ReduceContext): GameState {
  const sale = sellProductsFrom(state, count);
  if (sale === null) {
    return reject(ctx, state, 'SELL_PRODUCTS', 'nothing-to-do');
  }
  ctx.emit?.({
    type: 'PRODUCT_SOLD',
    simTimeMs: state.simTimeMs,
    products: sale.parts,
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
  // A bay holds only so many machines (spec §4): growing the fleet past that
  // means buying another config slot, which is what makes slots cost money.
  if (slotRoom(state, ctx.content, slot) <= 0) {
    return reject(ctx, state, 'BUY_PRINTER', 'slot-full');
  }
  const curves = curveRegistryFor(ctx.content.curves);
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
  const curves = curveRegistryFor(ctx.content.curves);
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
  const curves = curveRegistryFor(ctx.content.curves);
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

// --- slots, fleet and the fork (spec §4, §5B) --------------------------------

function applyBuySlot(state: GameState, unlockId: string, ctx: ReduceContext): GameState {
  const blocked = slotUnlockAvailability(state, ctx.content, unlockId);
  if (blocked !== null) {
    return reject(ctx, state, 'BUY_SLOT', blocked);
  }
  const curves = curveRegistryFor(ctx.content.curves);
  const purchase = purchaseSlot(state, ctx.content, curves, unlockId);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_SLOT', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'SLOT_UNLOCKED',
    simTimeMs: state.simTimeMs,
    unlockId,
    slotId: purchase.slotId,
    slotCount: purchase.state.slots.length,
    paid: purchase.cost.amount,
  });
  return purchase.state;
}

function applyAssignPrinter(
  state: GameState,
  action: Extract<Action, { type: 'ASSIGN_PRINTER' }>,
  ctx: ReduceContext,
): GameState {
  const move = assignPrinters(state, ctx.content, action.fromSlotId, action.toSlotId, action.count);
  if (typeof move === 'string') {
    return reject(ctx, state, 'ASSIGN_PRINTER', move);
  }
  ctx.emit?.({
    type: 'PRINTERS_ASSIGNED',
    simTimeMs: state.simTimeMs,
    fromSlotId: move.fromSlotId,
    toSlotId: move.toSlotId,
    moved: move.moved,
  });
  return move.state;
}

/**
 * Write a rota onto a slot (spec §5B) and load its first entry.
 *
 * Every entry is checked against the same unlock rules a hand-driven
 * `SET_SLOT_CONFIG` obeys, so a queue can never smuggle in a material the
 * machine tree has not opened. Loading the head entry immediately is what makes
 * "set the rota" one decision rather than two.
 */
function applySetSlotQueue(
  state: GameState,
  action: Extract<Action, { type: 'SET_SLOT_QUEUE' }>,
  ctx: ReduceContext,
): GameState {
  const index = slotIndexOf(state, action.slotId);
  const slot = state.slots.at(index);
  if (index < 0 || slot === undefined) {
    return reject(ctx, state, 'SET_SLOT_QUEUE', 'unknown-target');
  }
  if (!queueEntriesResolve(ctx.content, action.entries)) {
    return reject(ctx, state, 'SET_SLOT_QUEUE', 'unknown-target');
  }
  for (const entry of action.entries) {
    const availability = configAvailability(state, ctx.content, entry.materialId, entry.objectId);
    if (availability !== null) {
      return reject(ctx, state, 'SET_SLOT_QUEUE', availability);
    }
  }
  // The rota is the automation's feature, not a free one: without the
  // auto-changeover unit installed there is nothing to turn the queue.
  const rotaOwned = changeoverAutomationDefs(ctx.content).some(
    (def) => automationLevel(state, def.id) > 0,
  );
  if (!rotaOwned) {
    return reject(ctx, state, 'SET_SLOT_QUEUE', 'missing-prerequisite');
  }
  const queued = withSlot(state, index, {
    ...slot,
    queue: action.entries,
    queueIndex: 0,
    queueBatches: 0,
  });
  ctx.emit?.({
    type: 'SLOT_QUEUE_SET',
    simTimeMs: state.simTimeMs,
    slotId: action.slotId,
    entries: action.entries.length,
  });
  const head = action.entries.at(0);
  // A bay mid-purge cannot be re-loaded (the nozzle is already half-flushed),
  // so the rota is written and the head entry waits for the rotation that
  // follows the current batch. Attempting the load anyway would emit a
  // `SET_SLOT_CONFIG` rejection for an action nobody asked for.
  if (head === undefined || slot.changeoverMs > 0) {
    return queued;
  }
  return applySetSlotConfig(queued, action.slotId, head.materialId, head.objectId, ctx);
}

function applyChooseFork(state: GameState, forkId: string, ctx: ReduceContext): GameState {
  const blocked = forkAvailability(state, ctx.content, forkId);
  if (blocked !== null) {
    return reject(ctx, state, 'CHOOSE_FORK', blocked);
  }
  const curves = curveRegistryFor(ctx.content.curves);
  const choice = commitFork(state, ctx.content, curves, forkId);
  if (choice === null) {
    return reject(ctx, state, 'CHOOSE_FORK', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'FORK_CHOSEN',
    simTimeMs: state.simTimeMs,
    forkId: choice.def.id,
    slotCapacity: choice.def.slotCapacity,
    paid: choice.cost.amount,
  });
  return choice.state;
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

// --- the Design Studio, prestige and the presses (spec §5D, §5E) -------------

function applyCreateDesign(state: GameState, designId: string, ctx: ReduceContext): GameState {
  const modifiers = computeModifiers(state, ctx.content);
  const blocked = designAvailability(state, ctx.content, modifiers, designId);
  if (blocked !== null) {
    return reject(ctx, state, 'CREATE_DESIGN', blocked);
  }
  const curves = curveRegistryFor(ctx.content.curves);
  const draft = startDesignDraft(state, ctx.content, curves, designId);
  if (draft === null) {
    return reject(ctx, state, 'CREATE_DESIGN', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'DESIGN_STARTED',
    simTimeMs: state.simTimeMs,
    designId,
    designMinutes: draft.def.designDesignMinutes,
    paid: draft.cost.amount,
  });
  return draft.state;
}

/**
 * The melt-down (spec §5D). Everything the run built is scrapped; the Designs
 * and the retained balances cross over untouched, and the next run rebuilds
 * itself because the workshop has now done it once.
 */
function applyPrestige(state: GameState, ctx: ReduceContext): GameState {
  const curves = curveRegistryFor(ctx.content.curves);
  const blocked = prestigeAvailability(state, ctx.content, curves);
  if (blocked !== null) {
    return reject(ctx, state, 'PRESTIGE', blocked);
  }
  const result = meltDown(state, ctx.content, curves);
  ctx.emit?.({
    type: 'PRESTIGED',
    simTimeMs: state.simTimeMs,
    platesAwarded: result.platesAwarded,
    platesHeld: result.state.resources.plates,
    runNumber: result.state.stats.prestigeCount,
    designsKept: Object.keys(result.state.designs).length,
  });
  return result.state;
}

/**
 * Pre-print one section of the Fabricator (spec §7.3) — the Farm build's way of
 * staying in the running for a print only Goliath may attempt.
 */
function applyPrintSection(state: GameState, ctx: ReduceContext): GameState {
  const curves = curveRegistryFor(ctx.content.curves);
  const blocked = sectionAvailability(state, ctx.content, curves);
  if (blocked !== null) {
    return reject(ctx, state, 'PRINT_SECTION', blocked);
  }
  const started = startSection(state, ctx.content, curves);
  if (started === null) {
    return reject(ctx, state, 'PRINT_SECTION', 'insufficient-resources');
  }
  return started.state;
}

/** Commit every bay to the last print there is (spec §4, §6 phase 6). */
function applyStartFabricator(state: GameState, ctx: ReduceContext): GameState {
  const blocked = fabricatorAvailability(state, ctx.content);
  if (blocked !== null) {
    return reject(ctx, state, 'START_FABRICATOR', blocked);
  }
  const committed = beginFabricatorPrint(state, ctx.content);
  if (committed === null) {
    return reject(ctx, state, 'START_FABRICATOR', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'FABRICATOR_STARTED',
    simTimeMs: state.simTimeMs,
    durationMs: fabricatorDurationMs(state, ctx.content),
    sections: state.fabricator.sections,
    slotsCommitted: committed.slots.filter((slot) => slot.printerCount > 0).length,
  });
  return committed;
}

/** Start again on the far side of the credits (spec §18 M6). */
function applyNewGamePlus(
  state: GameState,
  modifierIds: readonly string[],
  ctx: ReduceContext,
): GameState {
  const blocked = newGamePlusAvailability(state, ctx.content);
  if (blocked !== null) {
    return reject(ctx, state, 'NEW_GAME_PLUS', blocked);
  }
  const restarted = startNewGamePlus(state, ctx.content, modifierIds);
  ctx.emit?.({
    type: 'NEW_GAME_PLUS_STARTED',
    simTimeMs: state.simTimeMs,
    run: restarted.run,
    modifierIds: restarted.modifierIds,
    designsKept: Object.keys(restarted.state.designs).length,
  });
  return restarted.state;
}

function applyBuyMoneyPrinter(
  state: GameState,
  moneyPrinterId: string,
  ctx: ReduceContext,
): GameState {
  const blocked = moneyPrinterAvailability(state, ctx.content, moneyPrinterId);
  if (blocked !== null) {
    return reject(ctx, state, 'BUY_MONEY_PRINTER', blocked);
  }
  const curves = curveRegistryFor(ctx.content.curves);
  const purchase = purchaseMoneyPrinter(state, ctx.content, curves, moneyPrinterId);
  if (purchase === null) {
    return reject(ctx, state, 'BUY_MONEY_PRINTER', 'insufficient-resources');
  }
  ctx.emit?.({
    type: 'MONEY_PRINTER_INSTALLED',
    simTimeMs: state.simTimeMs,
    moneyPrinterId,
    level: purchase.level,
    paid: purchase.cost.amount,
  });
  return purchase.state;
}
