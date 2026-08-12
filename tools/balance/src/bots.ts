import {
  type Action,
  type Content,
  type GameState,
  type MaterialDef,
  type ObjectDef,
  affordableBatch,
  attachPiece,
  buyFilament,
  buyPrinter,
  createCurveRegistry,
  filamentPrice,
  isPhaseReached,
  isPieceReady,
  nextPiece,
  nextPrinterCost,
  resolveSlotConfig,
  sellParts,
  setSlotConfig,
  startPrint,
} from '@printhead/core';
import type { Bot, BotView } from './harness.js';

/**
 * Bot strategies (spec §12.1). A bot only ever returns `Action`s — it has no
 * private state and no private economy, so whatever it achieves, a player could
 * achieve by clicking the same buttons.
 *
 * M1 ships `idle` (the lower bound) and `greedy-spender` (the upper bound).
 * `balanced` and `idle-heavy` arrive with the mechanics that make them
 * distinguishable — materials, automation and the market — in M3.
 */
const CHECK_IN_SECONDS = 5;
const IDLE_CHECK_IN_SECONDS = 600;

/**
 * How much filament the greedy bot restocks at a time, measured in batches the
 * current fleet can print. Big enough that restocking is not the bottleneck,
 * small enough that it never dumps its whole part inventory on the market.
 */
const RESTOCK_BATCHES = 25;

/** Does nothing at all — the lower bound on progress. */
export const idleBot: Bot = {
  id: 'idle',
  checkInDesignSeconds: IDLE_CHECK_IN_SECONDS,
  decide: () => [],
};

function unlocked<T extends { readonly id: string; readonly unlockPhaseId: string }>(
  defs: readonly T[],
  content: Content,
  phaseId: string,
): readonly T[] {
  return defs.filter((def) => isPhaseReached(content.pacing.phases, phaseId, def.unlockPhaseId));
}

/** The unlocked object with the best parts-per-design-second — pure greed. */
function bestObject(content: Content, phaseId: string): ObjectDef | undefined {
  const candidates = unlocked(content.objects, content, phaseId);
  return candidates.reduce<ObjectDef | undefined>((best, object) => {
    if (best === undefined) {
      return object;
    }
    const rate = object.partsYield / object.printDesignSeconds;
    const bestRate = best.partsYield / best.printDesignSeconds;
    return rate > bestRate ? object : best;
  }, undefined);
}

/** The cheapest unlocked material — PLA early, by construction (spec §3). */
function cheapestMaterial(content: Content, phaseId: string): MaterialDef | undefined {
  const candidates = unlocked(content.materials, content, phaseId);
  return candidates.reduce<MaterialDef | undefined>(
    (best, material) =>
      best === undefined || material.costPerGram < best.costPerGram ? material : best,
    undefined,
  );
}

/**
 * The intro is not optional: no printer, no economy. Attach the next piece the
 * moment its bench work is done.
 */
function introMove(state: GameState, content: Content): Action | null {
  const piece = nextPiece(state.assembly, content);
  if (piece === null || !isPieceReady(state.assembly)) {
    return null;
  }
  return attachPiece(piece.id);
}

/**
 * Keep the fleet fed. Parts are saved for printers, so the bot liquidates only
 * as many as the restock actually costs — greedy about capacity, not about cash.
 *
 * The bot must never stall while it still holds *something* it could convert
 * into filament: a spender that waits for a full order it cannot afford is a
 * deadlock, not a strategy. So it always buys as much as the till covers, down
 * to a single print's worth.
 */
function restockMoves(
  state: GameState,
  content: Content,
  slotIndex: number,
  material: MaterialDef,
): readonly Action[] {
  const slot = state.slots[slotIndex];
  if (slot === undefined) {
    return [];
  }
  const config = resolveSlotConfig(content, slot);
  if (config === null || material.costPerGram <= 0) {
    return [];
  }
  const perPrint = config.object.filamentGrams;
  const printers = Math.max(slot.printerCount, 1);
  const stock = state.filamentGrams[material.id] ?? 0;
  if (affordableBatch(config, printers, stock) >= printers) {
    return [];
  }

  const wanted = perPrint * printers * RESTOCK_BATCHES;
  const moves: Action[] = [];

  // Sell just enough parts to cover the order, if the till is short.
  let money = state.resources.money;
  const shortfall = filamentPrice(material, wanted) - money;
  if (shortfall > 0 && state.resources.parts > 0) {
    const unitValue = state.partsValue / state.resources.parts;
    if (unitValue > 0) {
      const needed = Math.min(Math.ceil(shortfall / unitValue), state.resources.parts);
      moves.push(sellParts(needed));
      money += needed * unitValue;
    }
  }

  const grams = Math.min(wanted, Math.floor(money / material.costPerGram));
  if (grams < perPrint) {
    // Cannot even fund one print; selling more would not help either.
    return moves.length > 0 ? moves : [];
  }
  moves.push(buyFilament(material.id, grams));
  return moves;
}

/**
 * `greedy-spender` (spec §12.1): buys capacity the instant it can pay for it,
 * and otherwise keeps the printers running. It is the fast bound on progression
 * — if the budget holds for this bot, no player is starved of things to do.
 */
export const greedySpenderBot: Bot = {
  id: 'greedy-spender',
  checkInDesignSeconds: CHECK_IN_SECONDS,
  decide: ({ state, content }: BotView): readonly Action[] => {
    const intro = introMove(state, content);
    if (intro !== null) {
      return [intro];
    }

    const slotIndex = 0;
    const slot = state.slots[slotIndex];
    if (slot === undefined) {
      return [];
    }
    const material = cheapestMaterial(content, state.phaseId);
    const object = bestObject(content, state.phaseId);
    if (material === undefined || object === undefined) {
      return [];
    }

    const moves: Action[] = [];

    // Parts the current phase offers no way to spend are dead weight: cash them
    // in. This is what makes the intro end when the player has actually sold
    // something, rather than whenever the starting spool happens to run out.
    const phase = content.pacing.phases.find((candidate) => candidate.id === state.phaseId);
    const canInvest = phase?.allowedActions.includes('BUY_PRINTER') ?? false;
    const canSell = phase?.allowedActions.includes('SELL_PARTS') ?? false;
    if (!canInvest && canSell && state.resources.parts > 0) {
      moves.push(sellParts(null));
    }

    if (slot.materialId !== material.id || slot.objectId !== object.id) {
      // Changeover is free in M1; M3 gives it a cost and this becomes a real
      // decision rather than a reflex.
      if (slot.run === null) {
        moves.push(setSlotConfig(slot.id, material.id, object.id));
      }
      return moves;
    }

    // Spend parts on capacity as soon as the curve price is met (spec §5B).
    const curves = createCurveRegistry(content.curves);
    for (const printer of unlocked(content.printers, content, state.phaseId)) {
      const cost = nextPrinterCost(state, content, curves, printer.id);
      if (cost !== null && cost.resource === 'parts' && state.resources.parts >= cost.amount) {
        moves.push(buyPrinter(printer.id, slot.id));
        return moves;
      }
    }

    moves.push(...restockMoves(state, content, slotIndex, material));
    if (slot.run === null) {
      moves.push(startPrint(slot.id));
    }
    return moves;
  },
};

export const BOTS: readonly Bot[] = [idleBot, greedySpenderBot];

/** The bot the CI budget gate measures (spec §12.6). */
export const REFERENCE_BOT = greedySpenderBot;

export function findBot(id: string): Bot {
  const bot = BOTS.find((candidate) => candidate.id === id);
  if (bot === undefined) {
    throw new Error(`unknown bot: ${id} (known: ${BOTS.map((b) => b.id).join(', ')})`);
  }
  return bot;
}
