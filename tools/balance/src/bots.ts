import {
  type Action,
  type AutomationDef,
  type Content,
  type CurveRegistry,
  type GameState,
  type MaterialDef,
  type ObjectDef,
  type UpgradeDef,
  affordableBatch,
  attachPiece,
  automationAvailability,
  buyAutomation,
  buyFilament,
  buyPrinter,
  buyUpgrade,
  createCurveRegistry,
  hasRecycler,
  isMaterialAvailable,
  isPhaseReached,
  isPieceReady,
  maxBuyableGrams,
  nextAutomationCost,
  nextPiece,
  nextPrinterCost,
  nextUpgradeCost,
  quoteFor,
  recycleScrap,
  resolveSlotConfig,
  sellParts,
  setAutomation,
  setSlotConfig,
  startPrint,
  unitPartValue,
  upgradeAvailability,
} from '@printhead/core';
import type { Bot, BotView } from './harness.js';

/**
 * Bot strategies (spec §12.1). A bot only ever returns `Action`s — it has no
 * private state and no private economy, so whatever it achieves, a player could
 * achieve by clicking the same buttons.
 *
 * The three shipped strategies are the spec's trio, and they differ in exactly
 * two dimensions rather than in three unrelated code paths:
 *
 * | bot             | check-in | policy                                    |
 * |-----------------|----------|-------------------------------------------|
 * | `greedy-spender`| 5 s      | spends the instant it can; no reserve      |
 * | `balanced`      | 5 s      | keeps a filament buffer, upgrades first    |
 * | `idle-heavy`    | 10 min   | the balanced policy, checked in rarely     |
 *
 * `balanced` is the reference the CI budget gate measures (spec §12.6): it is
 * the player the pacing table is written for. `greedy-spender` is the fast
 * bound and `idle-heavy` the slow one, and the harness reports all three.
 */
const CHECK_IN_SECONDS = 5;
const IDLE_HEAVY_CHECK_IN_SECONDS = 600;

/**
 * How much filament a restock buys, measured in batches the current fleet can
 * print. Big enough that restocking is not the bottleneck, small enough that it
 * never dumps the whole part inventory on the market.
 */
const RESTOCK_BATCHES = 25;

/**
 * A changeover costs time and a purge (spec §3), so a bot that re-loaded the
 * slot every time the market wobbled would spend the whole game purging. It
 * only switches material when the new one is *decisively* better.
 */
const MATERIAL_SWITCH_ADVANTAGE = 1.25;

/**
 * The registry is derived purely from the content set, and `decide` runs
 * thousands of times per simulated run (and a full run per tuner iteration), so
 * it is built once per content set rather than once per check-in.
 */
const curveRegistries = new WeakMap<Content, CurveRegistry>();

function curveRegistryFor(content: Content): CurveRegistry {
  const cached = curveRegistries.get(content);
  if (cached !== undefined) {
    return cached;
  }
  const registry = createCurveRegistry(content.curves);
  curveRegistries.set(content, registry);
  return registry;
}

/** Does nothing at all — the lower bound on progress. */
export const idleBot: Bot = {
  id: 'idle',
  checkInDesignSeconds: IDLE_HEAVY_CHECK_IN_SECONDS,
  decide: () => [],
};

function phaseAllows(state: GameState, content: Content, action: Action['type']): boolean {
  const phase = content.pacing.phases.find((candidate) => candidate.id === state.phaseId);
  return phase?.allowedActions.some((allowed) => allowed === action) ?? false;
}

function unlocked<T extends { readonly id: string; readonly unlockPhaseId: string }>(
  defs: readonly T[],
  content: Content,
  phaseId: string,
): readonly T[] {
  return defs.filter((def) => isPhaseReached(content.pacing.phases, phaseId, def.unlockPhaseId));
}

/** The unlocked object with the best parts-per-design-second. */
function bestObject(content: Content, phaseId: string): ObjectDef | undefined {
  return unlocked(content.objects, content, phaseId).reduce<ObjectDef | undefined>(
    (best, object) => {
      if (best === undefined) {
        return object;
      }
      const rate = object.partsYield / object.printDesignSeconds;
      const bestRate = best.partsYield / best.printDesignSeconds;
      return rate > bestRate ? object : best;
    },
    undefined,
  );
}

/**
 * Materials are gated by the machine tree as well as the phase (spec §3), so
 * "what can I load?" is a question only the sim can answer.
 */
function availableMaterials(state: GameState, content: Content): readonly MaterialDef[] {
  return content.materials.filter((material) => isMaterialAvailable(state, content, material.id));
}

function cheapestMaterial(state: GameState, content: Content): MaterialDef | undefined {
  return availableMaterials(state, content).reduce<MaterialDef | undefined>(
    (best, material) =>
      best === undefined || material.costPerGram < best.costPerGram ? material : best,
    undefined,
  );
}

/** Money value of one gram of filament once it has been through the printer. */
function marginOf(
  state: GameState,
  content: Content,
  material: MaterialDef,
  object: ObjectDef,
): number {
  const quote = quoteFor(state, content, material.id);
  if (quote === null || quote.buyPerGram <= 0) {
    return 0;
  }
  return (
    (object.partsYield * object.basePartValue * material.valueMultiplier) /
    (object.filamentGrams * quote.buyPerGram)
  );
}

/**
 * The material with the best value per gram — but only if it beats what is
 * already loaded by enough to be worth the changeover.
 */
function bestMaterial(
  state: GameState,
  content: Content,
  object: ObjectDef,
  loadedId: string | null,
): MaterialDef | undefined {
  const candidates = availableMaterials(state, content);
  const best = candidates.reduce<MaterialDef | undefined>(
    (winner, material) =>
      winner === undefined ||
      marginOf(state, content, material, object) > marginOf(state, content, winner, object)
        ? material
        : winner,
    undefined,
  );
  const loaded = candidates.find((material) => material.id === loadedId);
  if (best === undefined || loaded === undefined || best.id === loaded.id) {
    return best;
  }
  const worthIt =
    marginOf(state, content, best, object) >
    marginOf(state, content, loaded, object) * MATERIAL_SWITCH_ADVANTAGE;
  return worthIt ? best : loaded;
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

/** The cheapest upgrade the tree currently allows and the ledger can pay for. */
function affordableUpgrade(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): UpgradeDef | undefined {
  let best: { def: UpgradeDef; amount: number } | undefined;
  for (const def of content.upgrades) {
    if (upgradeAvailability(state, content, def.id) !== null) {
      continue;
    }
    const cost = nextUpgradeCost(state, content, curves, def.id);
    if (cost === null || cost.resource === 'filament') {
      continue;
    }
    if (state.resources[cost.resource] < cost.amount) {
      continue;
    }
    if (best === undefined || cost.amount < best.amount) {
      best = { def, amount: cost.amount };
    }
  }
  return best?.def;
}

function affordableAutomation(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): AutomationDef | undefined {
  for (const def of content.automation) {
    if (automationAvailability(state, content, def.id) !== null) {
      continue;
    }
    const cost = nextAutomationCost(state, content, curves, def.id);
    if (cost === null || cost.resource === 'filament') {
      continue;
    }
    if (state.resources[cost.resource] >= cost.amount) {
      return def;
    }
  }
  return undefined;
}

/**
 * Keep the fleet fed. Parts are saved for capacity, so the bot liquidates only
 * as many as the restock actually costs — greedy about throughput, not cash.
 *
 * A spender that waits for a full order it cannot afford is a deadlock, not a
 * strategy, so it always buys as much as the till covers, down to one print.
 */
function restockMoves(state: GameState, content: Content, slotIndex: number): readonly Action[] {
  const slot = state.slots[slotIndex];
  if (slot === undefined) {
    return [];
  }
  const config = resolveSlotConfig(content, slot);
  if (config === null) {
    return [];
  }
  const material = config.material;
  const quote = quoteFor(state, content, material.id);
  if (quote === null || quote.buyPerGram <= 0) {
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
  const shortfall = quote.buyPerGram * wanted - money;
  if (shortfall > 0 && state.resources.parts > 0 && phaseAllows(state, content, 'SELL_PARTS')) {
    const unitValue = unitPartValue(state);
    if (unitValue > 0) {
      const needed = Math.min(Math.ceil(shortfall / unitValue), state.resources.parts);
      moves.push(sellParts(needed));
      money += needed * unitValue;
    }
  }

  // Size the order against what the fill will actually cost, not against the
  // displayed ask: a buy moves the price it is filled at, and an order sized
  // off the shop window is rejected for being a few coins short.
  const grams = Math.min(
    wanted,
    Math.floor(maxBuyableGrams(state, content, material.id, Math.max(money, 0))),
  );
  if (grams < perPrint) {
    // Cannot even fund one print; selling more would not help either.
    return moves;
  }
  moves.push(buyFilament(material.id, grams));
  return moves;
}

/**
 * Keep the auto-seller's float above whatever the workshop is saving up for.
 *
 * This is the automation decision a real player makes: an auto-sell threshold
 * left at its default will cash in the parts you were saving for printer #5.
 * The bot re-tunes it as the cost curve climbs, and only when the setting has
 * drifted far enough to matter — one `SET_AUTOMATION` per check-in would swamp
 * the action log.
 */
const THRESHOLD_DRIFT = 0.1;

function retuneAutoSell(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): readonly Action[] {
  if (!phaseAllows(state, content, 'SET_AUTOMATION')) {
    return [];
  }
  const printer = unlocked(content.printers, content, state.phaseId)[0];
  const target = printer === undefined ? null : nextPrinterCost(state, content, curves, printer.id);
  if (target === null || target.resource !== 'parts') {
    return [];
  }
  const moves: Action[] = [];
  for (const def of content.automation) {
    if (def.behavior !== 'sell-parts') {
      continue;
    }
    const owned = state.automation[def.id];
    if (owned === undefined || owned.level <= 0) {
      continue;
    }
    if (Math.abs(owned.threshold - target.amount) > target.amount * THRESHOLD_DRIFT) {
      moves.push(setAutomation(def.id, { threshold: target.amount }));
    }
  }
  return moves;
}

/** Feed the recycler whatever the failed prints left behind (spec §2). */
function recycleMoves(state: GameState, content: Content): readonly Action[] {
  if (!phaseAllows(state, content, 'RECYCLE_SCRAP') || state.resources.scrap <= 0) {
    return [];
  }
  if (!hasRecycler(state, content)) {
    return [];
  }
  const slot = state.slots[0];
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  const target = config?.material ?? cheapestMaterial(state, content);
  if (target === undefined || target.costPerGram <= 0) {
    return [];
  }
  return [recycleScrap(target.id, null)];
}

export interface PolicyOptions {
  readonly id: string;
  readonly checkInDesignSeconds: number;
  /** Buy capacity before machine nodes — the greedy reflex. */
  readonly capacityFirst: boolean;
  /**
   * Working capital, measured in batches of filament, that the bot refuses to
   * spend. A bot with no reserve can strand itself: parts buy machines, money
   * buys filament, and a workshop with no parts, no money and an empty spool
   * has nothing left to sell and nothing left to print. Found exactly that way
   * — the balanced bot bought two upgrades and then sat in bench for the rest
   * of the run issuing prints it could not feed.
   */
  readonly reserveBatches: number;
  /** Pick the highest-margin material rather than the cheapest one. */
  readonly chaseMargin: boolean;
}

/** What one batch of filament costs at today's price. */
function batchCostOf(
  state: GameState,
  content: Content,
  slotIndex: number,
): { readonly grams: number; readonly money: number } {
  const slot = state.slots[slotIndex];
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  if (slot === undefined || config === null) {
    return { grams: 0, money: 0 };
  }
  const grams = config.object.filamentGrams * Math.max(slot.printerCount, 1);
  const quote = quoteFor(state, content, config.material.id);
  return { grams, money: grams * (quote?.buyPerGram ?? 0) };
}

/**
 * Would the workshop still be able to feed its printers after spending
 * `partsSpent` parts? Anything else is a self-inflicted dead end.
 */
function staysSolvent(
  state: GameState,
  content: Content,
  slotIndex: number,
  partsSpent: number,
  reserveBatches: number,
): boolean {
  const slot = state.slots[slotIndex];
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  if (slot === undefined || config === null) {
    return true;
  }
  const batch = batchCostOf(state, content, slotIndex);
  const stocked = state.filamentGrams[config.material.id] ?? 0;
  if (stocked >= batch.grams * (reserveBatches + 1)) {
    return true;
  }
  const partsLeft = Math.max(state.resources.parts - partsSpent, 0);
  const partValue = config.object.basePartValue * config.material.valueMultiplier;
  const capital = state.resources.money + partsLeft * partValue;
  return capital >= batch.money * (reserveBatches + 1);
}

/**
 * One policy, three parameterisations. Writing the strategies as knobs on a
 * shared decision order is deliberate: it keeps them comparable (any gap in the
 * timeline is caused by the knobs, not by one bot having forgotten a mechanic)
 * and it means a new mechanic is wired into every bot at once, which is what
 * spec §19 asks for.
 */
export function createPolicyBot(options: PolicyOptions): Bot {
  return {
    id: options.id,
    checkInDesignSeconds: options.checkInDesignSeconds,
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
      const object = bestObject(content, state.phaseId);
      if (object === undefined) {
        return [];
      }
      const material = options.chaseMargin
        ? (bestMaterial(state, content, object, slot.materialId) ??
          cheapestMaterial(state, content))
        : cheapestMaterial(state, content);
      if (material === undefined) {
        return [];
      }

      const moves: Action[] = [];
      const curves = curveRegistryFor(content);
      const canInvest =
        phaseAllows(state, content, 'BUY_PRINTER') || phaseAllows(state, content, 'BUY_UPGRADE');
      const canSell = phaseAllows(state, content, 'SELL_PARTS');

      // Parts the current phase offers no way to spend are dead weight: cash
      // them in. This is what makes the intro end when the player has actually
      // sold something, rather than whenever the starting spool runs out.
      if (!canInvest && canSell && state.resources.parts > 0) {
        moves.push(sellParts(null));
      }

      // Load the slot. Changing material costs a changeover (spec §3), so the
      // bot only does it when the *material* is genuinely different.
      if (slot.materialId !== material.id || slot.objectId !== object.id) {
        if (slot.run === null && slot.changeoverMs <= 0) {
          moves.push(setSlotConfig(slot.id, material.id, object.id));
        }
        return moves;
      }

      moves.push(...recycleMoves(state, content));
      moves.push(...retuneAutoSell(state, content, curves));

      const printer = unlocked(content.printers, content, state.phaseId)[0];
      const printerCost =
        printer === undefined ? null : nextPrinterCost(state, content, curves, printer.id);
      const solvent = (cost: { resource: string; amount: number } | null): boolean =>
        cost !== null &&
        staysSolvent(
          state,
          content,
          slotIndex,
          cost.resource === 'parts' ? cost.amount : 0,
          options.reserveBatches,
        );

      const canBuyPrinter =
        printer !== undefined &&
        printerCost !== null &&
        printerCost.resource !== 'filament' &&
        phaseAllows(state, content, 'BUY_PRINTER') &&
        state.resources[printerCost.resource] >= printerCost.amount &&
        solvent(printerCost);

      const upgradeCandidate = phaseAllows(state, content, 'BUY_UPGRADE')
        ? affordableUpgrade(state, content, curves)
        : undefined;
      const upgrade =
        upgradeCandidate !== undefined &&
        solvent(nextUpgradeCost(state, content, curves, upgradeCandidate.id))
          ? upgradeCandidate
          : undefined;
      const automationCandidate = phaseAllows(state, content, 'BUY_AUTOMATION')
        ? affordableAutomation(state, content, curves)
        : undefined;
      const automation =
        automationCandidate !== undefined &&
        solvent(nextAutomationCost(state, content, curves, automationCandidate.id))
          ? automationCandidate
          : undefined;

      const investments: readonly Action[] = options.capacityFirst
        ? [
            ...(canBuyPrinter && printer !== undefined ? [buyPrinter(printer.id, slot.id)] : []),
            ...(upgrade === undefined ? [] : [buyUpgrade(upgrade.id)]),
            ...(automation === undefined ? [] : [buyAutomation(automation.id)]),
          ]
        : [
            ...(upgrade === undefined ? [] : [buyUpgrade(upgrade.id)]),
            ...(automation === undefined ? [] : [buyAutomation(automation.id)]),
            ...(canBuyPrinter && printer !== undefined ? [buyPrinter(printer.id, slot.id)] : []),
          ];
      const investment = investments[0];
      if (investment !== undefined) {
        moves.push(investment);
        return moves;
      }

      // Parts are the currency of capacity, so they are *hoarded*, never
      // dumped: the only sale a bot makes is the one `restockMoves` needs to
      // fund the next spool. A bot that banked its surplus every check-in
      // would never save up for anything (found the hard way — the balanced
      // bot sat in bench for 415 design-minutes with one printer).
      moves.push(...restockMoves(state, content, slotIndex));

      // Only ask for a print the reducer would actually accept: an idle slot,
      // out of changeover, with filament for at least one of its printers.
      const config = resolveSlotConfig(content, slot);
      const stocked = config === null ? 0 : (state.filamentGrams[config.material.id] ?? 0);
      const feedable = config !== null && affordableBatch(config, slot.printerCount, stocked) > 0;
      if (slot.run === null && slot.changeoverMs <= 0 && feedable) {
        moves.push(startPrint(slot.id));
      }
      return moves;
    },
  };
}

/**
 * `greedy-spender`: buys capacity the instant it can pay for it and holds no
 * reserve. The fast bound on progression — if the budget holds for this bot, no
 * player is starved of things to do.
 */
export const greedySpenderBot = createPolicyBot({
  id: 'greedy-spender',
  checkInDesignSeconds: CHECK_IN_SECONDS,
  capacityFirst: true,
  reserveBatches: 0,
  chaseMargin: false,
});

/**
 * `balanced`: the reference player. Buys the cheapest useful machine node
 * before more machines, chases the material with the better margin, and keeps a
 * little cash back so a restock never blocks an upgrade.
 */
export const balancedBot = createPolicyBot({
  id: 'balanced',
  checkInDesignSeconds: CHECK_IN_SECONDS,
  capacityFirst: false,
  reserveBatches: 3,
  chaseMargin: true,
});

/**
 * `idle-heavy`: the same policy, but the player only looks at the game every
 * ten design-minutes (spec §12.1). What it measures is how much of the loop
 * survives without attention — the reason automation exists.
 */
export const idleHeavyBot = createPolicyBot({
  id: 'idle-heavy',
  checkInDesignSeconds: IDLE_HEAVY_CHECK_IN_SECONDS,
  capacityFirst: false,
  reserveBatches: 12,
  chaseMargin: true,
});

export const BOTS: readonly Bot[] = [idleBot, greedySpenderBot, balancedBot, idleHeavyBot];

/** The bot the CI budget gate measures (spec §12.6). */
export const REFERENCE_BOT = balancedBot;

export function findBot(id: string): Bot {
  const bot = BOTS.find((candidate) => candidate.id === id);
  if (bot === undefined) {
    throw new Error(`unknown bot: ${id} (known: ${BOTS.map((b) => b.id).join(', ')})`);
  }
  return bot;
}
