import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { clamp } from '../math/scalar.js';
import type { GameState, SlotState } from '../state/game-state.js';
import { assemblyPieces, isPieceReady, nextPiece } from '../systems/assembly.js';
import { automationAvailability, nextAutomationCost } from '../systems/automation.js';
import { hasRecycler, recyclerYield } from '../systems/failure.js';
import { quoteAll } from '../systems/market.js';
import { getPhase } from '../systems/phases.js';
import { bestPrinterTier, resolveSlotConfig, runProgress } from '../systems/printing.js';
import { drawScrap } from '../systems/resources.js';
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
  LedgerVisual,
  MarketVisual,
  RecyclerVisual,
  SlotVisual,
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
  const purgeMs = config === null ? NONE : config.material.changeoverDesignSeconds * MS_PER_SECOND;
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
    changingOver: slot.changeoverMs > NONE,
    changeoverProgress:
      slot.changeoverMs > NONE && purgeMs > NONE
        ? clamp((purgeMs - slot.changeoverMs) / purgeMs, NONE, FULL)
        : NONE,
    failureRisk: clamp(slot.failureCharge / content.failure.model.chargeThreshold, NONE, FULL),
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

function toMarketVisual(state: GameState, content: Content): readonly MarketVisual[] {
  const materials = indexById(content.materials);
  return quoteAll(state, content).map((quote) => ({
    materialId: quote.materialId,
    materialName: materials.get(quote.materialId)?.name ?? quote.materialId,
    tradeable: quote.tradeable,
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

export function toVisualState(state: GameState, content: Content): VisualState {
  const modifiers = computeModifiers(state, content);
  const machineTier = bestPrinterTier(state, content, modifiers);
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
    market: toMarketVisual(state, content),
    upgrades: toUpgradeVisuals(state, content),
    automation: toAutomationVisuals(state, content),
    recycler: toRecyclerVisual(state, content, modifiers),
  };
}

/** Slots the player can actually see working — a convenience for HUD callers. */
export function occupiedSlots(visual: VisualState): readonly SlotVisual[] {
  return visual.slots.filter((slot) => slot.occupied);
}
