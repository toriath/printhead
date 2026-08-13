import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import type { CurveRegistry } from '../curves/evaluate.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE, MS_PER_SECOND } from '../engine/constants.js';
import { clamp } from '../math/scalar.js';
import type { GameState, SlotState } from '../state/game-state.js';
import { assemblyPieces, isPieceReady, nextPiece } from '../systems/assembly.js';
import { automationAvailability, nextAutomationCost } from '../systems/automation.js';
import {
  designAvailability,
  designSlotCount,
  freeDesignSlots,
  nextDesignCost,
  productValueOf,
} from '../systems/designs.js';
import {
  allSlotsCommitted,
  buildProgress,
  committedPrinters,
  currentBackdropId,
  currentLayer,
  fabricatorAvailability,
  fabricatorDurationMs,
  forkAllowsFinalPrint,
  hasBlueprint,
  newGamePlusAvailability,
  nextSectionCost,
  sectionAvailability,
} from '../systems/endgame.js';
import { endingElapsedMs, endingProgress, endingStage } from '../systems/ending.js';
import { hasRecycler, recyclerYield } from '../systems/failure.js';
import { assignedPrinters, fleetCapacity, printersPerSlot } from '../systems/fleet.js';
import { chosenFork, forkAvailability, forkCost } from '../systems/forks.js';
import { inflationMultiplier, isInflating } from '../systems/inflation.js';
import { quoteAll } from '../systems/market.js';
import { getPhase } from '../systems/phases.js';
import {
  moneyPrintRate,
  moneyPrinterAvailability,
  moneyPrinterLevel,
  nextMoneyPrinterCost,
  platesFor,
  prestigeAvailability,
} from '../systems/prestige.js';
import { bestPrinterTier, resolveSlotConfig, runProgress } from '../systems/printing.js';
import { countPrinters } from '../systems/requirements.js';
import { drawScrap } from '../systems/resources.js';
import {
  effectiveSlotCapacity,
  hardSlotMaximum,
  nextSlotCost,
  nextSlotUnlock,
  slotUnlockAvailability,
} from '../systems/slots.js';
import {
  type ModifierMap,
  computeModifiers,
  isMaterialAvailable,
  nextUpgradeCost,
  upgradeAvailability,
} from '../systems/upgrades.js';
import type {
  AssemblyVisual,
  AutomationVisual,
  DesignVisual,
  EndingVisual,
  FabricatorVisual,
  FleetVisual,
  ForkVisual,
  InflationVisual,
  LedgerVisual,
  MarketVisual,
  MoneyPrinterVisual,
  NewGamePlusModifierVisual,
  PrestigeVisual,
  QueueEntryVisual,
  RecyclerVisual,
  SlotUnlockVisual,
  SlotVisual,
  StudioVisual,
  UpgradeVisual,
  VisualState,
} from './schema.js';
import { VISUAL_STATE_VERSION } from './schema.js';

/**
 * `toVisualState` — the Projection (Adapter) of spec §15, and the *only* thing
 * a renderer is allowed to read. Everything the workshop draws is derived here
 * from `GameState` + `Content`, so a renderer never needs a content table, a
 * clock or a rule of its own.
 *
 * Since M3 that includes the *offers*: the market board, the machine tree and
 * the automation rack are projected as lists with "can I?" and "can I afford
 * it?" already resolved by the same functions the reducer uses. A shell that
 * decided those for itself would eventually disagree with the reducer, and the
 * player would meet a button that does nothing.
 *
 * The shape it produces is frozen and versioned in `./schema.ts`.
 */

const NONE = 0;
const FULL = 1;

/**
 * Deterministic per-slot animation offset — no rng, no clock (spec §13).
 * `total` is the slot count and this is only ever called from inside a map over
 * those slots, so it cannot be zero; no guard, because a guard nothing can
 * reach is a branch no test can ever justify.
 */
function phaseOffsetOf(index: number, total: number): number {
  return index / total;
}

function toQueueVisual(slot: SlotState, content: Content): readonly QueueEntryVisual[] {
  const materials = indexById(content.materials);
  const objects = indexById(content.objects);
  const entries: QueueEntryVisual[] = [];
  slot.queue.forEach((entry, index) => {
    const material = materials.get(entry.materialId);
    const object = objects.get(entry.objectId);
    if (material === undefined || object === undefined) {
      return;
    }
    entries.push({
      materialId: material.id,
      materialName: material.name,
      objectId: object.id,
      objectName: object.name,
      batches: entry.batches,
      current: index === slot.queueIndex,
    });
  });
  return entries;
}

function toSlotVisual(
  slot: SlotState,
  content: Content,
  index: number,
  slotCount: number,
  machineTier: number,
  printerCapacity: number,
): SlotVisual {
  const config = resolveSlotConfig(content, slot);
  const staffed = slot.printerCount > NONE;
  // "Occupied" means the bay is actually working: a config *and* a machine.
  // A staffed bay with no config still shows its printer — the player built it
  // and it should not vanish while they decide what to load into it.
  const occupied = config !== null && staffed;
  const purgeMs = config === null ? NONE : config.material.changeoverDesignSeconds * MS_PER_SECOND;
  return {
    slotId: slot.id,
    index,
    materialId: config?.material.id ?? null,
    materialName: config?.material.name ?? null,
    objectId: config?.recipeId ?? null,
    objectName: config?.recipeName ?? null,
    output: config?.pool ?? 'parts',
    designId: config?.design?.id ?? null,
    machineTier: staffed ? machineTier : NONE,
    printerCount: slot.printerCount,
    printerCapacity,
    phaseOffset: phaseOffsetOf(index, slotCount),
    occupied,
    running: slot.run !== null,
    progress: slot.run === null ? NONE : runProgress(slot.run),
    batch: slot.run?.batch ?? NONE,
    changingOver: slot.changeoverMs > NONE,
    changeoverProgress:
      slot.changeoverMs > NONE && purgeMs > NONE
        ? clamp((purgeMs - slot.changeoverMs) / purgeMs, NONE, FULL)
        : NONE,
    failureRisk: clamp(slot.failureCharge / content.failure.model.chargeThreshold, NONE, FULL),
    queue: toQueueVisual(slot, content),
    queueBatches: slot.queueBatches,
  };
}

/** The next bay on sale (spec §4), with the reason it is not, if it is not. */
function toSlotUnlockVisual(state: GameState, content: Content): SlotUnlockVisual | null {
  const def = nextSlotUnlock(state, content);
  if (def === null) {
    return null;
  }
  const curves = createCurveRegistry(content.curves);
  const cost = nextSlotCost(content, curves, def.id);
  const blocked = slotUnlockAvailability(state, content, def.id);
  return {
    unlockId: def.id,
    name: def.name,
    available: blocked === null,
    affordable: cost !== null && affordable(state, cost.resource, cost.amount),
    cost: cost?.amount ?? NONE,
    costResource: cost?.resource ?? def.costResource,
    blockedReason: blocked,
  };
}

/** Both branches of the per-run fork (spec §5B) — one of them may be taken. */
function toForkVisuals(state: GameState, content: Content): readonly ForkVisual[] {
  const curves = createCurveRegistry(content.curves);
  return content.forks.map((def) => {
    const cost = forkCost(content, curves, def.id);
    return {
      forkId: def.id,
      name: def.name,
      description: def.description,
      layout: def.visual,
      chosen: state.forkId === def.id,
      available: forkAvailability(state, content, def.id) === null,
      affordable: cost !== null && affordable(state, cost.resource, cost.amount),
      cost: cost?.amount ?? NONE,
      costResource: cost?.resource ?? def.costResource,
      requiredForFinalPrint: def.requiredForFinalPrint,
    };
  });
}

function toFleetVisual(state: GameState, content: Content, active: number): FleetVisual {
  return {
    printers: countPrinters(state),
    assigned: assignedPrinters(state),
    slotsOwned: state.slots.length,
    slotsActive: active,
    slotsMaximum: hardSlotMaximum(content),
    printerCapacity: fleetCapacity(state, content, active),
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
    selfAssembling: state.selfAssembling,
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
    products: state.resources.products,
    plates: state.resources.plates,
    filamentGrams: state.filamentGrams,
  };
}

/**
 * The Design Studio (spec §5D). Every design in content is projected, drafted
 * or not, with the reason it cannot be drafted attached — so the shell offers
 * the catalogue and greys out what the machine tree has not opened, without
 * knowing that resin is the gate.
 */
function toStudioVisual(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
  curves: CurveRegistry,
): StudioVisual {
  const drafting = state.studio;
  const draftDef =
    drafting === null ? undefined : indexById(content.designs).get(drafting.designId);
  const draftTotalMs = (draftDef?.designDesignMinutes ?? NONE) * MS_PER_MINUTE;
  const designs: DesignVisual[] = content.designs.map((def) => {
    const owned = state.designs[def.id];
    const level = owned?.level ?? NONE;
    const cost = nextDesignCost(state, content, curves, def.id);
    const blocked = designAvailability(state, content, modifiers, def.id);
    return {
      designId: def.id,
      name: def.name,
      materialId: def.requiredMaterialId,
      level,
      maxLevel: def.maxLevel,
      owned: owned !== undefined,
      levelProgress:
        owned === undefined || owned.level >= def.maxLevel
          ? NONE
          : clamp(owned.printsOnLevel / def.printsPerLevel, NONE, FULL),
      productValue: productValueOf(def, curves, Math.max(level, FULL), modifiers),
      capstone: def.id === content.prestige.requiredDesignId,
      available: blocked === null,
      affordable: cost !== null && affordable(state, cost.resource, cost.amount),
      cost: cost?.amount ?? NONE,
      costResource: cost?.resource ?? def.costResource,
      blockedReason: blocked,
    };
  });
  return {
    slots: designSlotCount(content, modifiers),
    freeSlots: freeDesignSlots(state, content, modifiers),
    draftingDesignId: drafting?.designId ?? null,
    draftingName: draftDef?.name ?? null,
    draftProgress:
      drafting === null || draftTotalMs <= NONE
        ? NONE
        : clamp((draftTotalMs - drafting.remainingMs) / draftTotalMs, NONE, FULL),
    designs,
  };
}

/** The melt-down offer (spec §5D) and the presses it pays for (spec §5E). */
function toPrestigeVisual(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): PrestigeVisual {
  const blocked = prestigeAvailability(state, content, curves);
  return {
    available: blocked === null,
    platesOnOffer: platesFor(state, content, curves),
    platesHeld: state.resources.plates,
    runsCompleted: state.stats.prestigeCount,
    moneyPerDesignSecond: moneyPrintRate(state, content, curves),
    blockedReason: blocked,
  };
}

function toMoneyPrinterVisuals(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): readonly MoneyPrinterVisual[] {
  return content.prestige.moneyPrinters.map((def) => {
    const cost = nextMoneyPrinterCost(state, content, curves, def.id);
    return {
      moneyPrinterId: def.id,
      name: def.name,
      tier: def.tier,
      level: moneyPrinterLevel(state, def.id),
      maxLevel: def.maxLevel,
      available: moneyPrinterAvailability(state, content, def.id) === null,
      affordable: cost !== null && affordable(state, cost.resource, cost.amount),
      cost: cost?.amount ?? NONE,
      costResource: cost?.resource ?? def.costResource,
    };
  });
}

function toMarketVisual(state: GameState, content: Content): readonly MarketVisual[] {
  const materials = indexById(content.materials);
  return quoteAll(state, content).map((quote) => ({
    materialId: quote.materialId,
    materialName: materials.get(quote.materialId)?.name ?? quote.materialId,
    tradeable: quote.tradeable,
    priceResource: quote.priceResource,
    available: isMaterialAvailable(state, content, quote.materialId),
    buyPerGram: quote.buyPerGram,
    sellPerGram: quote.sellPerGram,
    priceMultiplier: quote.multiplier,
    // An unlisted shelf is unlimited; reporting Infinity would fail the schema
    // and mean nothing to a reader, so "no shelf" is projected as zero and
    // `tradeable: false` is what tells the renderer to hide the number.
    stockGrams: Number.isFinite(quote.stockGrams) ? quote.stockGrams : NONE,
    heldGrams: state.filamentGrams[quote.materialId] ?? NONE,
  }));
}

function affordable(state: GameState, resource: string, amount: number): boolean {
  if (resource === 'filament') {
    return false;
  }
  return state.resources[resource as keyof typeof state.resources] >= amount;
}

function toUpgradeVisuals(state: GameState, content: Content): readonly UpgradeVisual[] {
  const curves = createCurveRegistry(content.curves);
  return content.upgrades.map((def) => {
    const cost = nextUpgradeCost(state, content, curves, def.id);
    return {
      upgradeId: def.id,
      name: def.name,
      tree: def.tree,
      level: state.upgrades[def.id] ?? NONE,
      maxLevel: def.maxLevel,
      available: upgradeAvailability(state, content, def.id) === null,
      affordable: cost !== null && affordable(state, cost.resource, cost.amount),
      cost: cost?.amount ?? NONE,
      costResource: cost?.resource ?? def.costResource,
    };
  });
}

function toAutomationVisuals(state: GameState, content: Content): readonly AutomationVisual[] {
  const curves = createCurveRegistry(content.curves);
  return content.automation.map((def) => {
    const owned = state.automation[def.id];
    const cost = nextAutomationCost(state, content, curves, def.id);
    return {
      automationId: def.id,
      name: def.name,
      behavior: def.behavior,
      level: owned?.level ?? NONE,
      installed: (owned?.level ?? NONE) > NONE,
      enabled: owned?.enabled ?? false,
      threshold: owned?.threshold ?? def.defaultThreshold,
      available: automationAvailability(state, content, def.id) === null,
      affordable: cost !== null && affordable(state, cost.resource, cost.amount),
      cost: cost?.amount ?? NONE,
      costResource: cost?.resource ?? def.costResource,
    };
  });
}

/**
 * What the scrap bin is worth. The target is whatever the first slot is loaded
 * with, because that is what the player would recycle into — and quoting the
 * yield in *that* material is the only way the number means anything.
 */
function toRecyclerVisual(
  state: GameState,
  content: Content,
  modifiers: ModifierMap,
): RecyclerVisual {
  const installed = hasRecycler(state, content);
  const slot = state.slots.at(NONE);
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  const target = config?.material ?? content.materials.at(NONE);
  const draw = drawScrap(state, state.resources.scrap);
  const yieldFraction = recyclerYield(modifiers);
  const yieldGrams =
    installed && target !== undefined && target.costPerGram > NONE
      ? (draw.value * yieldFraction) / target.costPerGram
      : NONE;
  return {
    installed,
    scrapGrams: state.resources.scrap,
    yieldGrams,
    yieldMaterialId: target?.id ?? null,
  };
}

/** On-screen inflation (spec §6 phase 5), and the reading that caused it. */
function toInflationVisual(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): InflationVisual {
  return {
    active: isInflating(state, content),
    multiplier: inflationMultiplier(state, content, curves),
    moneyPrinted: state.stats.moneyPrinted,
  };
}

/**
 * The final print (spec §6 phase 6). Everything a renderer needs to draw the
 * one synced build — including the layer it is on — plus everything a shell
 * needs to offer it, with the reason it is not on offer already resolved by the
 * same function the reducer consults.
 */
function toFabricatorVisual(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): FabricatorVisual {
  const def = content.endgame.fabricator;
  const run = state.fabricator.run;
  const blocked = fabricatorAvailability(state, content);
  const sectionBlocked = sectionAvailability(state, content, curves);
  const sectionCost = nextSectionCost(state, content, curves);
  return {
    unlocked: hasBlueprint(state, content),
    available: blocked === null,
    blockedReason: blocked,
    running: run !== null,
    complete: state.fabricator.completedAtMs !== null,
    progress: run === null && state.fabricator.completedAtMs !== null ? FULL : buildProgress(run),
    layer: currentLayer(state, content),
    layers: def.layers,
    remainingMs: Math.max(run?.remainingMs ?? NONE, NONE),
    totalMs: run?.totalMs ?? fabricatorDurationMs(state, content),
    materialId: def.materialId,
    filamentGrams: def.filamentGrams,
    heldGrams: state.filamentGrams[def.materialId] ?? NONE,
    sections: state.fabricator.sections,
    maxSections: def.maxSections,
    sectionRunning: state.fabricator.sectionRun !== null,
    sectionProgress: buildProgress(state.fabricator.sectionRun),
    sectionAvailable: sectionBlocked === null,
    sectionBlockedReason: sectionBlocked,
    sectionCost: sectionCost.amount,
    sectionCostResource: sectionCost.resource,
    forkAllows: forkAllowsFinalPrint(state, content),
    slotsCommitted: allSlotsCommitted(state, content),
    committedPrinters: committedPrinters(state, content),
    requiredPrinters: def.requiredPrinters,
  };
}

/** 0..1 through whichever stage the ending is in — what a fade runs on. */
function stageProgressOf(state: GameState, content: Content): number {
  const { numbersDesignSeconds, museumDesignSeconds, creditsDesignSeconds } =
    content.endgame.ending;
  const elapsed = endingElapsedMs(state);
  const numbers = numbersDesignSeconds * MS_PER_SECOND;
  const museum = museumDesignSeconds * MS_PER_SECOND;
  const credits = creditsDesignSeconds * MS_PER_SECOND;
  switch (endingStage(state, content)) {
    case 'none':
      return NONE;
    case 'numbers':
      return clamp(elapsed / numbers, NONE, FULL);
    case 'museum':
      return clamp((elapsed - numbers) / museum, NONE, FULL);
    case 'credits':
      return clamp((elapsed - numbers - museum) / credits, NONE, FULL);
    case 'complete':
      return FULL;
  }
}

/**
 * The ending (spec §6 phase 6). The credits are carried across so the renderer
 * holds no copy of them, and the line count is derived from the stage's own
 * progress — the credits literally print out, one line at a time.
 */
function toEndingVisual(state: GameState, content: Content, machineTier: number): EndingVisual {
  const stage = endingStage(state, content);
  const credits = content.endgame.ending.credits;
  const stageProgress = stageProgressOf(state, content);
  const printed =
    stage === 'credits'
      ? Math.min(Math.floor(stageProgress * credits.length) + FULL, credits.length)
      : stage === 'complete'
        ? credits.length
        : NONE;
  const modifiers: readonly NewGamePlusModifierVisual[] = content.endgame.newGamePlus.modifiers.map(
    (def) => ({
      modifierId: def.id,
      name: def.name,
      description: def.description,
      active: state.ngPlus.modifierIds.includes(def.id),
    }),
  );
  return {
    stage,
    active: stage !== 'none',
    progress: endingProgress(state, content),
    stageProgress,
    museumPrinterId: content.endgame.ending.museumPrinterId,
    museumTier: machineTier,
    credits,
    creditLines: printed,
    // Spec §6: "numbers fade to ∞". The ledger stops meaning anything the
    // moment the Fabricator lands, and the renderer is told so rather than
    // being left to decide when a number has become absurd.
    infinite: stage !== 'none',
    newGamePlusAvailable: newGamePlusAvailability(state, content) === null,
    newGamePlusRun: state.ngPlus.run,
    modifiers,
  };
}

export function toVisualState(state: GameState, content: Content): VisualState {
  const modifiers = computeModifiers(state, content);
  const curves = createCurveRegistry(content.curves);
  const machineTier = bestPrinterTier(state, content, modifiers);
  const fork = chosenFork(state, content);
  /*
   * How many bays the workshop is actually running. Normally that is every bay
   * the player owns; a Goliath run caps it at one, because the fork melted the
   * fleet into a single machine (spec §5B). Slots past the cap are inert — the
   * fork emptied them — so they are not projected at all rather than drawn as
   * bays the player might try to use.
   */
  const active = effectiveSlotCapacity(state, content);
  const shown = state.slots.slice(NONE, active);
  const perSlot = printersPerSlot(state, content);
  return {
    version: VISUAL_STATE_VERSION,
    phaseId: state.phaseId,
    phaseName: getPhase(content.pacing.phases, state.phaseId).name,
    simTimeMs: state.simTimeMs,
    // The rack is drawn to the hard maximum so the shape of what is still to
    // come is legible (spec §4: empty bays as faint outlines) — except under
    // Goliath, where there is exactly one machine and nothing else to show.
    slotCapacity: fork?.slotCapacity ?? hardSlotMaximum(content),
    goliath: fork?.visual === 'goliath',
    // Every owned slot is projected, empty ones included: the "empty slot =
    // faint outline" rule is the renderer drawing data, not inventing it.
    slots: shown.map((slot, index) =>
      toSlotVisual(slot, content, index, shown.length, machineTier, perSlot),
    ),
    fleet: toFleetVisual(state, content, active),
    slotUnlock: toSlotUnlockVisual(state, content),
    forks: toForkVisuals(state, content),
    assembly: toAssemblyVisual(state, content),
    ledger: toLedgerVisual(state),
    market: toMarketVisual(state, content),
    upgrades: toUpgradeVisuals(state, content),
    automation: toAutomationVisuals(state, content),
    recycler: toRecyclerVisual(state, content, modifiers),
    studio: toStudioVisual(state, content, modifiers, curves),
    prestige: toPrestigeVisual(state, content, curves),
    moneyPrinters: toMoneyPrinterVisuals(state, content, curves),
    backdrop: currentBackdropId(state, content),
    inflation: toInflationVisual(state, content, curves),
    fabricator: toFabricatorVisual(state, content, curves),
    ending: toEndingVisual(state, content, machineTier),
  };
}

/** Slots the player can actually see working — a convenience for HUD callers. */
export function occupiedSlots(visual: VisualState): readonly SlotVisual[] {
  return visual.slots.filter((slot) => slot.occupied);
}
