import {
  type Action,
  type AutomationDef,
  type BuySlotAction,
  type ChooseForkAction,
  type Content,
  type CurveRegistry,
  type DesignDef,
  type ForkDef,
  type GameState,
  type MaterialDef,
  type ObjectDef,
  type SlotState,
  type UpgradeDef,
  affordableBatch,
  assignPrinter,
  attachPiece,
  automationAvailability,
  buyAutomation,
  buyFilament,
  buyMoneyPrinter,
  buyPrinter,
  buySlot,
  buyUpgrade,
  chooseFork,
  computeModifiers,
  createCurveRegistry,
  createDesign,
  designAvailability,
  effectiveSlotCapacity,
  forkAvailability,
  forkCost,
  hasRecycler,
  isForkChosen,
  isMaterialAvailable,
  isPhaseReached,
  isPieceReady,
  maxBuyableGrams,
  moneyPrinterAvailability,
  nextAutomationCost,
  nextDesignCost,
  nextMoneyPrinterCost,
  nextPiece,
  nextPrinterCost,
  nextSlotCost,
  nextSlotUnlock,
  nextUpgradeCost,
  platesFor,
  prestige,
  prestigeAvailability,
  printersPerSlot,
  productValueOf,
  quoteFor,
  recycleScrap,
  resolveSlotConfig,
  sellParts,
  sellProducts,
  setAutomation,
  setSlotConfig,
  setSlotDesign,
  setSlotQueue,
  slotUnlockAvailability,
  slotWithRoom,
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

const SECONDS_PER_MINUTE = 60;

/**
 * Grams per design-minute the whole fleet would eat if it ran flat out on this
 * recipe. Machine speed is left out on purpose: it scales every candidate
 * equally, so it cannot change which one wins.
 */
function appetiteGramsPerMinute(
  state: GameState,
  material: MaterialDef,
  object: ObjectDef,
): number {
  let printers = 0;
  for (const slot of state.slots) {
    printers += slot.printerCount;
  }
  return (
    (printers * object.filamentGrams * material.printSpeedMultiplier * SECONDS_PER_MINUTE) /
    object.printDesignSeconds
  );
}

/**
 * How much of that appetite the shelf can actually feed.
 *
 * A market material restocks at a fixed rate (spec §7.2), and a rack big enough
 * to outpace it spends most of its time idle however good the margin looks. The
 * balanced bot learned this the hard way: it chased PETG's margin with
 * twenty-four machines into a shelf that refills at a fifth of what they eat,
 * and sat in the studio for three hundred design-minutes producing almost
 * nothing. An infinite material (spec §3: PLA) has no shelf and no limit.
 */
function supplyFraction(content: Content, material: MaterialDef, appetite: number): number {
  const listing = content.market.listings.find((entry) => entry.materialId === material.id);
  if (listing === undefined || appetite <= 0) {
    return 1;
  }
  return Math.min(1, listing.restockGramsPerDesignMinute / appetite);
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
  const perGram =
    (object.partsYield * object.basePartValue * material.valueMultiplier) /
    (object.filamentGrams * quote.buyPerGram);
  return (
    perGram * supplyFraction(content, material, appetiteGramsPerMinute(state, material, object))
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

/**
 * The cheapest automation on offer, in content order — unless the player is the
 * sort who is not there to watch. `preferRota` puts the auto-changeover unit at
 * the front of the queue, which is what an inattentive player would actually
 * buy first: it is the one automation that keeps the workshop *varying* what it
 * makes while nobody is looking.
 */
function affordableAutomation(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  preferRota = false,
): AutomationDef | undefined {
  const ordered = preferRota
    ? [...content.automation].sort((a, b) => {
        const rank = (def: AutomationDef): number => (def.behavior === 'auto-changeover' ? 0 : 1);
        return rank(a) - rank(b);
      })
    : content.automation;
  for (const def of ordered) {
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
function restockMoves(state: GameState, content: Content, slot: SlotState): readonly Action[] {
  const config = resolveSlotConfig(content, slot);
  if (config === null) {
    return [];
  }
  const material = config.material;
  const quote = quoteFor(state, content, material.id);
  if (quote === null || quote.buyPerGram <= 0) {
    return [];
  }
  const perPrint = config.filamentGrams;
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

/**
 * What the workshop is currently saving up for, in Parts.
 *
 * This is the float the auto-seller must leave behind, and getting it wrong is
 * a silent softlock rather than a slow game: once the rack is full the next
 * useful purchase is a *config slot* costing hundreds of Parts, and an
 * auto-seller still floating at the price of a printer will cash in every Part
 * above a dozen or so. Found exactly that way — the balanced bot sat in farm
 * for 392 design-minutes with eight printers, £18k in the bank and 31 Parts,
 * because the thing it needed could only be bought with Parts it kept selling.
 */
function savingTargetParts(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): number | null {
  const printer = unlocked(content.printers, content, state.phaseId)[0];
  const printerCost =
    printer === undefined ? null : nextPrinterCost(state, content, curves, printer.id);
  if (slotWithRoom(state, content) !== null) {
    return printerCost !== null && printerCost.resource === 'parts' ? printerCost.amount : null;
  }
  const unlock = nextSlotUnlock(state, content);
  const slotCost =
    unlock !== null && slotUnlockAvailability(state, content, unlock.id) === null
      ? nextSlotCost(content, curves, unlock.id)
      : null;
  if (slotCost !== null && slotCost.resource === 'parts') {
    return slotCost.amount;
  }
  // Nowhere to put a machine and no bay to buy: the fork is the next thing
  // worth Parts, and after that there is nothing left but the tree.
  for (const def of content.forks) {
    if (forkAvailability(state, content, def.id) !== null) {
      continue;
    }
    const cost = forkCost(content, curves, def.id);
    if (cost !== null && cost.resource === 'parts') {
      return cost.amount;
    }
  }
  return printerCost !== null && printerCost.resource === 'parts' ? printerCost.amount : null;
}

function retuneAutoSell(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): readonly Action[] {
  if (!phaseAllows(state, content, 'SET_AUTOMATION')) {
    return [];
  }
  const amount = savingTargetParts(state, content, curves);
  if (amount === null) {
    return [];
  }
  const target = { amount };
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

/**
 * Keep the auto-buyer's target stock in step with the rack.
 *
 * The default is written for one printer; a bay of eight eats more filament in
 * a single batch than the shipped threshold tops it up to, so a workshop that
 * never re-tunes it starves the moment it grows. That is a real setting a real
 * player drags upwards, and leaving the bot on the default made the studio look
 * like a content problem when it was a fleet-scaling one.
 */
function retuneAutoBuy(state: GameState, content: Content): readonly Action[] {
  if (!phaseAllows(state, content, 'SET_AUTOMATION')) {
    return [];
  }
  const target = batchCostOf(state, content).grams * RESTOCK_BATCHES;
  if (target <= 0) {
    return [];
  }
  const moves: Action[] = [];
  for (const def of content.automation) {
    if (def.behavior !== 'buy-filament') {
      continue;
    }
    const owned = state.automation[def.id];
    if (owned === undefined || owned.level <= 0) {
      continue;
    }
    if (Math.abs(owned.threshold - target) > target * THRESHOLD_DRIFT) {
      moves.push(setAutomation(def.id, { threshold: target }));
    }
  }
  return moves;
}

/**
 * Turn Parts into Money when Money is what the next purchase wants.
 *
 * Parts are hoarded for capacity, which is right until the Design Studio opens
 * and the only thing worth buying is priced in Money (spec §2's flow). Without
 * this the bot sits on a full rack and a full parts bin, one commission short
 * of the rest of the game.
 *
 * It sells **exactly** what the commission costs and not a Part more. The
 * obvious alternative — sell whatever is surplus to the capacity fund — starves
 * on the greedy policy, whose next printer costs tens of thousands of Parts, so
 * every Part is always "spoken for" and the studio never opens. A commission is
 * a bounded, one-off price; paying it can set the capacity fund back by that
 * much and no further.
 */
function fundMoneyGoal(state: GameState, content: Content, goal: number): readonly Action[] {
  if (goal <= state.resources.money || !phaseAllows(state, content, 'SELL_PARTS')) {
    return [];
  }
  const unitValue = unitPartValue(state);
  if (unitValue <= 0 || state.resources.parts <= 0) {
    return [];
  }
  const needed = Math.min(
    Math.ceil((goal - state.resources.money) / unitValue),
    state.resources.parts,
  );
  return needed > 0 ? [sellParts(needed)] : [];
}

/** The cheapest Money-priced commission the studio would accept right now. */
function studioMoneyGoal(state: GameState, content: Content, curves: CurveRegistry): number {
  if (!phaseAllows(state, content, 'CREATE_DESIGN') || state.studio !== null) {
    return 0;
  }
  const modifiers = computeModifiers(state, content);
  let cheapest = 0;
  for (const def of content.designs) {
    const blocked = designAvailability(state, content, modifiers, def.id);
    // `slot-full` means every design slot is taken; a desk would fix that, and
    // a desk is priced in Money too, so the goal is still worth funding.
    if (blocked !== null && blocked !== 'slot-full') {
      continue;
    }
    const cost = nextDesignCost(state, content, curves, def.id);
    if (cost === null || cost.resource !== 'money') {
      continue;
    }
    if (cheapest === 0 || cost.amount < cheapest) {
      cheapest = cost.amount;
    }
  }
  return cheapest;
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
  /**
   * Which branch of the per-run fork this player commits to (spec §5B).
   * `throughput` takes whichever branch multiplies output hardest; `flexibility`
   * keeps the rack, and with it the ability to run several configurations at
   * once. Both branches therefore get bot coverage rather than one of them
   * being dead content.
   */
  readonly preferFork: 'throughput' | 'flexibility';
  /**
   * Buy the auto-changeover unit and write a rota onto each bay (spec §5B).
   *
   * Only worth it for a player who is not there to reconfigure by hand: an
   * attentive bot re-loads a slot the moment the margin moves, and a rota would
   * just add purges it did not ask for. That is why `idle-heavy` uses it and
   * the twitchier strategies do not — the mechanic is exercised by the player
   * it was designed for.
   */
  readonly useQueues: boolean;
}

/** What one batch of filament costs at today's price, across every bay. */
function batchCostOf(
  state: GameState,
  content: Content,
): { readonly grams: number; readonly money: number } {
  let grams = 0;
  let money = 0;
  for (const slot of activeSlots(state, content)) {
    const config = resolveSlotConfig(content, slot);
    if (config === null) {
      continue;
    }
    const slotGrams = config.filamentGrams * Math.max(slot.printerCount, 1);
    const quote = quoteFor(state, content, config.material.id);
    grams += slotGrams;
    money += slotGrams * (quote?.buyPerGram ?? 0);
  }
  return { grams, money };
}

/**
 * Would the workshop still be able to feed its printers after spending
 * `partsSpent` parts? Anything else is a self-inflicted dead end.
 */
function staysSolvent(
  state: GameState,
  content: Content,
  partsSpent: number,
  reserveBatches: number,
): boolean {
  const slot = activeSlots(state, content)[0];
  const config = slot === undefined ? null : resolveSlotConfig(content, slot);
  if (slot === undefined || config === null) {
    return true;
  }
  const batch = batchCostOf(state, content);
  const stocked = state.filamentGrams[config.material.id] ?? 0;
  if (stocked >= batch.grams * (reserveBatches + 1)) {
    return true;
  }
  const partsLeft = Math.max(state.resources.parts - partsSpent, 0);
  const partValue =
    (config.object?.basePartValue ?? config.design?.baseProductValue ?? 0) *
    config.material.valueMultiplier;
  const capital = state.resources.money + partsLeft * partValue;
  return capital >= batch.money * (reserveBatches + 1);
}

// --- slots, fleet and the fork (spec §4, §5B) --------------------------------

/** The bays the workshop is actually running — a Goliath run has exactly one. */
function activeSlots(state: GameState, content: Content): readonly SlotState[] {
  return state.slots.slice(0, effectiveSlotCapacity(state, content));
}

/**
 * Buy the next bay when the rack is the thing holding the fleet back.
 *
 * A bay is only worth its price once the machines it would house have nowhere
 * else to stand (spec §4), so the bot waits until every existing bay is full
 * rather than buying capacity it cannot fill. That is also what makes the
 * purchase legible in a balance report: a slot appears exactly when the fleet
 * hits its ceiling.
 */
function slotMove(state: GameState, content: Content, curves: CurveRegistry): BuySlotAction | null {
  if (!phaseAllows(state, content, 'BUY_SLOT') || slotWithRoom(state, content) !== null) {
    return null;
  }
  const unlock = nextSlotUnlock(state, content);
  if (unlock === null || slotUnlockAvailability(state, content, unlock.id) !== null) {
    return null;
  }
  const cost = nextSlotCost(content, curves, unlock.id);
  if (cost === null || cost.resource === 'filament') {
    return null;
  }
  return state.resources[cost.resource] >= cost.amount ? buySlot(unlock.id) : null;
}

/**
 * Spread the fleet evenly. Machines only earn while their bay has a config and
 * filament, so a bay left empty next to a full one is pure waste; the bot moves
 * one machine per check-in, which converges without thrashing a running batch.
 */
function fleetMove(state: GameState, content: Content): Action | null {
  if (!phaseAllows(state, content, 'ASSIGN_PRINTER')) {
    return null;
  }
  const bays = activeSlots(state, content);
  if (bays.length < 2) {
    return null;
  }
  const fullest = bays.reduce((best, slot) =>
    slot.printerCount > best.printerCount ? slot : best,
  );
  const emptiest = bays.reduce((best, slot) =>
    slot.printerCount < best.printerCount ? slot : best,
  );
  if (fullest.id === emptiest.id || fullest.printerCount - emptiest.printerCount < 2) {
    return null;
  }
  if (emptiest.printerCount >= printersPerSlot(state, content)) {
    return null;
  }
  return assignPrinter(fullest.id, emptiest.id, 1);
}

/** How hard a branch multiplies raw output — speed × yield, folded from data. */
function forkOutput(def: ForkDef): number {
  return def.effects.reduce((total, effect) => {
    const scales = effect.type === 'printSpeedMultiplier' || effect.type === 'partsYieldMultiplier';
    return scales && effect.combine === 'multiply' ? total * effect.value : total;
  }, 1);
}

/**
 * Commit to Farm or Goliath (spec §5B). The choice is read off the fork defs
 * rather than off their ids: a `throughput` player takes whichever branch
 * multiplies output hardest, a `flexibility` player takes whichever keeps the
 * most bays. Content can therefore rename or re-balance the branches without
 * touching a bot.
 */
function forkMove(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
  prefer: PolicyOptions['preferFork'],
): ChooseForkAction | null {
  if (isForkChosen(state) || !phaseAllows(state, content, 'CHOOSE_FORK')) {
    return null;
  }
  const affordable = content.forks.filter((def) => {
    if (forkAvailability(state, content, def.id) !== null) {
      return false;
    }
    const cost = forkCost(content, curves, def.id);
    return (
      cost !== null && cost.resource !== 'filament' && state.resources[cost.resource] >= cost.amount
    );
  });
  const best = affordable.reduce<ForkDef | undefined>((winner, def) => {
    if (winner === undefined) {
      return def;
    }
    if (prefer === 'throughput') {
      return forkOutput(def) > forkOutput(winner) ? def : winner;
    }
    const bays = def.slotCapacity ?? Number.POSITIVE_INFINITY;
    const winnerBays = winner.slotCapacity ?? Number.POSITIVE_INFINITY;
    return bays > winnerBays ? def : winner;
  }, undefined);
  return best === undefined ? null : chooseFork(best.id);
}

/**
 * Write a rota onto a bay that has none (spec §5B). Two entries: what the bay
 * already prints, and the runner-up material — the point of a queue is that the
 * workshop keeps producing a mix while nobody is watching.
 */
function queueMoves(
  state: GameState,
  content: Content,
  object: ObjectDef,
  primary: MaterialDef,
): readonly Action[] {
  // The rota is the auto-changeover unit's feature (spec §5B): asking for one
  // before buying the unit is an action the reducer refuses, and a bot that
  // spends its check-ins on refused actions is not modelling a player.
  const owned = content.automation.some(
    (def) => def.behavior === 'auto-changeover' && (state.automation[def.id]?.level ?? 0) > 0,
  );
  if (!owned || !phaseAllows(state, content, 'SET_SLOT_QUEUE')) {
    return [];
  }
  const alternatives = availableMaterials(state, content).filter(
    (material) => material.id !== primary.id,
  );
  const second = alternatives.reduce<MaterialDef | undefined>(
    (best, material) =>
      best === undefined ||
      marginOf(state, content, material, object) > marginOf(state, content, best, object)
        ? material
        : best,
    undefined,
  );
  if (second === undefined) {
    return [];
  }
  const target = activeSlots(state, content).find(
    (slot) => slot.queue.length === 0 && slot.materialId === primary.id,
  );
  if (target === undefined) {
    return [];
  }
  return [
    setSlotQueue(target.id, [
      { materialId: primary.id, objectId: object.id, batches: QUEUE_BATCHES_PER_ENTRY },
      { materialId: second.id, objectId: object.id, batches: QUEUE_BATCHES_PER_ENTRY },
    ]),
  ];
}

/** Batches a rota entry prints before the bay rotates on. */
const QUEUE_BATCHES_PER_ENTRY = 12;

// --- the meta layer (spec §5D, §5E) ------------------------------------------

/**
 * A melt-down is only worth the rebuild if it pays for something. Below this
 * many Plates the bot keeps trading; the presses cost Plates, so a one-Plate
 * run would reset the workshop and buy nothing with the proceeds.
 */
const PRESTIGE_MIN_AWARD = 2;

/**
 * How much a melt-down must add to the Plate pile, as a fraction of what is
 * already on it.
 *
 * This is the whole prestige decision, and getting it wrong is the classic
 * idle-game failure in both directions. The first draft melted down the moment
 * the award cleared the content minimum, and the bot reset ten times in one
 * phase for one Plate a piece — the rebuild costs more than the reward, so the
 * run went backwards. A player waits until the next melt-down is *worth*
 * something relative to what they already have; with a square-root plate curve
 * that means each run has to be roughly the square of the last, which is
 * exactly the widening prestige spiral spec §6's phases 4–5 describe.
 */
const PRESTIGE_GROWTH = 1;

/** Bays the player keeps on Products once the studio opens (spec §5D). */
const DESIGN_BAYS = 1;

/**
 * The owned Design worth the most per Product at its current level, skipping
 * any whose material the machine tree has closed again — which a melt-down
 * does, since it takes the SLA unit with everything else.
 */
function bestOwnedDesign(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): DesignDef | undefined {
  const modifiers = computeModifiers(state, content);
  return content.designs
    .filter(
      (def) =>
        state.designs[def.id] !== undefined &&
        isMaterialAvailable(state, content, def.requiredMaterialId),
    )
    .reduce<DesignDef | undefined>((best, def) => {
      if (best === undefined) {
        return def;
      }
      const level = state.designs[def.id]?.level ?? 1;
      const bestLevel = state.designs[best.id]?.level ?? 1;
      return productValueOf(def, curves, level, modifiers) >
        productValueOf(best, curves, bestLevel, modifiers)
        ? def
        : best;
    }, undefined);
}

/**
 * Put a commission on the bench (spec §5D). The capstone comes first: it is the
 * best Product *and* the thing prestige waits on, so a player who wants to see
 * the rest of the game drafts it before anything decorative.
 */
function draftMove(state: GameState, content: Content, curves: CurveRegistry): Action | null {
  if (!phaseAllows(state, content, 'CREATE_DESIGN') || state.studio !== null) {
    return null;
  }
  const modifiers = computeModifiers(state, content);
  const candidates = content.designs.filter(
    (def) =>
      designAvailability(state, content, modifiers, def.id) === null &&
      (nextDesignCost(state, content, curves, def.id)?.amount ?? Number.POSITIVE_INFINITY) <=
        state.resources.money,
  );
  const capstone = candidates.find((def) => def.id === content.prestige.requiredDesignId);
  const chosen =
    capstone ??
    candidates.reduce<DesignDef | undefined>(
      (best, def) =>
        best === undefined ||
        productValueOf(def, curves, 1, modifiers) > productValueOf(best, curves, 1, modifiers)
          ? def
          : best,
      undefined,
    );
  return chosen === undefined ? null : createDesign(chosen.id);
}

/** Point a bay at the best Design owned, once there is one worth printing. */
function designBayMove(state: GameState, content: Content, curves: CurveRegistry): Action | null {
  if (!phaseAllows(state, content, 'SET_SLOT_DESIGN')) {
    return null;
  }
  const design = bestOwnedDesign(state, content, curves);
  if (design === undefined) {
    return null;
  }
  const bays = activeSlots(state, content);
  const onDesign = bays.filter((slot) => slot.designId !== null);
  if (onDesign.length >= Math.min(DESIGN_BAYS, Math.max(bays.length - 1, 1))) {
    // Already committed as many bays as the policy allows — but keep the one it
    // has pointed at the best design it now owns.
    const stale = onDesign.find((slot) => slot.designId !== design.id);
    return stale === undefined || stale.run !== null || stale.changeoverMs > 0
      ? null
      : setSlotDesign(stale.id, design.id);
  }
  // The last bay is the studio's: taking the first would stop the Parts economy
  // that pays for everything else.
  const target = [...bays]
    .reverse()
    .find((slot) => slot.printerCount > 0 && slot.designId === null);
  if (target === undefined || target.changeoverMs > 0) {
    return null;
  }
  return setSlotDesign(target.id, design.id);
}

/** Install the next press (spec §5E) — the only thing Plates are spent on. */
function moneyPrinterMove(
  state: GameState,
  content: Content,
  curves: CurveRegistry,
): Action | null {
  if (!phaseAllows(state, content, 'BUY_MONEY_PRINTER')) {
    return null;
  }
  for (const def of content.prestige.moneyPrinters) {
    if (moneyPrinterAvailability(state, content, def.id) !== null) {
      continue;
    }
    const cost = nextMoneyPrinterCost(state, content, curves, def.id);
    if (
      cost !== null &&
      cost.resource !== 'filament' &&
      state.resources[cost.resource] >= cost.amount
    ) {
      return buyMoneyPrinter(def.id);
    }
  }
  return null;
}

/**
 * Melt the workshop down (spec §5D) once the run is worth enough Plates to buy
 * something with. Everything before this — the designs, the capstone, the money
 * — was in service of this one button, and the bot presses it the moment the
 * arithmetic says yes.
 */
function prestigeMove(state: GameState, content: Content, curves: CurveRegistry): Action | null {
  if (!phaseAllows(state, content, 'PRESTIGE')) {
    return null;
  }
  if (prestigeAvailability(state, content, curves) !== null) {
    return null;
  }
  const award = platesFor(state, content, curves);
  const worthwhile = Math.max(
    PRESTIGE_MIN_AWARD,
    content.prestige.minimumPlates,
    state.resources.plates * PRESTIGE_GROWTH,
  );
  return award >= worthwhile ? prestige() : null;
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

      const bays = activeSlots(state, content);
      const first = bays[0];
      if (first === undefined) {
        return [];
      }
      const object = bestObject(content, state.phaseId);
      if (object === undefined) {
        return [];
      }
      const material = options.chaseMargin
        ? (bestMaterial(state, content, object, first.materialId) ??
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

      /*
       * Load every bay. A bay the fork left behind, or one just bought, is a
       * bay standing idle, so the rack is configured before anything is bought
       * — otherwise the bot would buy machines for a slot that prints nothing.
       * Changing material costs a changeover (spec §3), so a *loaded* bay is
       * only re-loaded when the material is genuinely different, and a bay with
       * a rota is left to the rota.
       */
      // A bay the studio has claimed is *not* misconfigured: it is printing
      // Products on purpose, and re-loading it with a stock object would throw
      // away the whole reason the Design Studio exists (spec §5D).
      const misconfigured = bays.find(
        (slot) =>
          slot.queue.length === 0 &&
          slot.designId === null &&
          (slot.materialId !== material.id || slot.objectId !== object.id),
      );
      if (misconfigured !== undefined) {
        if (misconfigured.run === null && misconfigured.changeoverMs <= 0) {
          moves.push(setSlotConfig(misconfigured.id, material.id, object.id));
        }
        return moves;
      }

      moves.push(...recycleMoves(state, content));
      moves.push(...retuneAutoSell(state, content, curves));
      moves.push(...retuneAutoBuy(state, content));
      moves.push(...fundMoneyGoal(state, content, studioMoneyGoal(state, content, curves)));

      /*
       * The meta layer, in the order a player would reach for it (spec §5D):
       * Products are only ever worth Money, so they are cashed in on sight; a
       * free bench gets a commission; a Design that exists gets a bay; a press
       * is installed the moment the Plates are there; and the melt-down is
       * taken as soon as it would pay for one.
       */
      if (state.resources.products > 0 && phaseAllows(state, content, 'SELL_PRODUCTS')) {
        moves.push(sellProducts(null));
      }
      const press = moneyPrinterMove(state, content, curves);
      if (press !== null) {
        moves.push(press);
      }
      const melt = prestigeMove(state, content, curves);
      if (melt !== null) {
        // Nothing after a melt-down means anything: the workshop it was about
        // to act on no longer exists.
        moves.push(melt);
        return moves;
      }
      const draft = draftMove(state, content, curves);
      if (draft !== null) {
        moves.push(draft);
      }
      const studioBay = designBayMove(state, content, curves);
      if (studioBay !== null) {
        moves.push(studioBay);
        return moves;
      }
      if (options.useQueues) {
        // Before the shopping, not after: a rota is set once per bay and costs
        // nothing, and a bot that only gets to it when there is nothing left to
        // buy never gets to it at all.
        moves.push(...queueMoves(state, content, object, material));
      }

      const rebalance = fleetMove(state, content);
      if (rebalance !== null) {
        moves.push(rebalance);
      }

      const printer = unlocked(content.printers, content, state.phaseId)[0];
      const printerCost =
        printer === undefined ? null : nextPrinterCost(state, content, curves, printer.id);
      const solvent = (cost: { resource: string; amount: number } | null): boolean =>
        cost !== null &&
        staysSolvent(
          state,
          content,
          cost.resource === 'parts' ? cost.amount : 0,
          options.reserveBatches,
        );

      // Where the next machine would stand. No room anywhere means the rack is
      // the bottleneck, and `slotMove` is what answers that.
      const housing = slotWithRoom(state, content);
      const canBuyPrinter =
        printer !== undefined &&
        housing !== null &&
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
        ? affordableAutomation(state, content, curves, options.useQueues)
        : undefined;
      const automation =
        automationCandidate !== undefined &&
        solvent(nextAutomationCost(state, content, curves, automationCandidate.id))
          ? automationCandidate
          : undefined;

      const slotPurchase = slotMove(state, content, curves);
      const slotBuy =
        slotPurchase !== null && solvent(nextSlotCost(content, curves, slotPurchase.unlockId))
          ? slotPurchase
          : null;
      const fork = forkMove(state, content, curves, options.preferFork);
      const forkBuy =
        fork !== null && solvent(forkCost(content, curves, fork.forkId)) ? fork : null;

      const capacityMoves: readonly Action[] = [
        ...(canBuyPrinter && printer !== undefined
          ? [buyPrinter(printer.id, housing?.id ?? '')]
          : []),
        ...(slotBuy === null ? [] : [slotBuy]),
      ];
      const treeMoves: readonly Action[] = [
        ...(upgrade === undefined ? [] : [buyUpgrade(upgrade.id)]),
        ...(automation === undefined ? [] : [buyAutomation(automation.id)]),
      ];
      // The fork is the one purchase that is never postponed: it is the run's
      // defining commitment (spec §5B) and everything after it is shaped by it.
      const investments: readonly Action[] =
        forkBuy !== null
          ? [forkBuy]
          : options.capacityFirst
            ? [...capacityMoves, ...treeMoves]
            : [...treeMoves, ...capacityMoves];
      const investment = investments[0];
      if (investment !== undefined) {
        moves.push(investment);
        return moves;
      }

      for (const slot of bays) {
        // Parts are the currency of capacity, so they are *hoarded*, never
        // dumped: the only sale a bot makes is the one `restockMoves` needs to
        // fund the next spool. A bot that banked its surplus every check-in
        // would never save up for anything (found the hard way — the balanced
        // bot sat in bench for 415 design-minutes with one printer).
        moves.push(...restockMoves(state, content, slot));

        // Only ask for a print the reducer would actually accept: an idle slot,
        // out of changeover, with filament for at least one of its printers.
        const config = resolveSlotConfig(content, slot);
        const stocked = config === null ? 0 : (state.filamentGrams[config.material.id] ?? 0);
        const feedable = config !== null && affordableBatch(config, slot.printerCount, stocked) > 0;
        if (slot.run === null && slot.changeoverMs <= 0 && feedable) {
          moves.push(startPrint(slot.id));
        }
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
  preferFork: 'throughput',
  useQueues: false,
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
  // The reference player keeps its rack: `greedy-spender` takes the other
  // branch, so between them the roster exercises both sides of the fork.
  preferFork: 'flexibility',
  useQueues: false,
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
  preferFork: 'flexibility',
  useQueues: true,
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
