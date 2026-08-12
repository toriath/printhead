import { indexById } from '../content/load.js';
import type { Content, MarketListing, MarketModel, MaterialDef } from '../content/schema.js';
import { MS_PER_MINUTE, TRADE_SEARCH_ITERATIONS } from '../engine/constants.js';
import { TAU, clamp, signedUnit } from '../math/scalar.js';
import { hashUnit } from '../rng/mulberry32.js';
import type { GameState, MarketLedger, MarketMaterialState } from '../state/game-state.js';
import { withFilament, withResource } from './resources.js';
import { type ModifierMap, computeModifiers, modifierOf } from './upgrades.js';

/**
 * The market (spec §7.2): **price = sine + seeded noise + supply response**,
 * per material, with flooding lowering the price.
 *
 * Three rules make this behave like an economy rather than a slot machine:
 *
 * 1. The price is a pure function of `(seed, design time, pressure)`. The noise
 *    term is hashed from the seed and a time bucket, never drawn from a stream,
 *    so a save reloaded mid-run sees exactly the curve it left — and offline
 *    catch-up reproduces it tick for tick.
 * 2. **A trade pays its own slippage.** The pressure a trade creates is applied
 *    *before* the trade is priced, so a buy is filled at the price it pushed up
 *    to and a sell at the price it pushed down to. Together with the spread
 *    this is what makes `buy → sell` strictly lossy (spec §13).
 * 3. Prices are clamped to `[minPriceMultiplier, maxPriceMultiplier]` from
 *    content, so no amount of dumping can drive a price negative or to a moon.
 *
 * NOTE: no gameplay numeric literals may appear in `systems/` (spec §11).
 */
const NONE = 0;
const IDENTITY = 1;

export interface MarketQuote {
  readonly materialId: string;
  /** Tradeable materials have a `market.json` listing; PLA does not. */
  readonly tradeable: boolean;
  /** Price multiplier applied to the listing's base price. */
  readonly multiplier: number;
  readonly buyPerGram: number;
  /** What the market pays you per gram — always below `buyPerGram`. */
  readonly sellPerGram: number;
  readonly stockGrams: number;
  readonly pressure: number;
}

export function marketListing(content: Content, materialId: string): MarketListing | undefined {
  return content.market.listings.find((listing) => listing.materialId === materialId);
}

export function marketStateOf(state: GameState, materialId: string): MarketMaterialState {
  return state.market[materialId] ?? { stockGrams: NONE, pressure: NONE };
}

export function designMinutesOf(state: GameState): number {
  return state.simTimeMs / MS_PER_MINUTE;
}

/**
 * The deterministic wobble. The sine gives the market a rhythm a player can
 * learn; the hashed noise stops that rhythm from being a metronome. Both are
 * functions of design time, so they scale with `targetHours` like everything
 * else (spec §8).
 */
export function priceMultiplier(
  model: MarketModel,
  materialId: string,
  designMinutes: number,
  pressure: number,
  seed: number,
): number {
  if (model.strategy === 'flat') {
    return IDENTITY;
  }
  const phase = hashUnit(`market-phase:${materialId}`, seed) * TAU;
  const sine =
    model.sineAmplitude * Math.sin((TAU * designMinutes) / model.periodDesignMinutes + phase);
  const bucket = Math.floor(designMinutes / model.noiseStepDesignMinutes);
  const noise =
    model.noiseAmplitude * signedUnit(hashUnit(`market-noise:${materialId}:${bucket}`, seed));
  const supply = model.supplyResponse * pressure;
  return clamp(
    IDENTITY + sine + noise - supply,
    model.minPriceMultiplier,
    model.maxPriceMultiplier,
  );
}

/** The house's cut, softened by any `marketFeeMultiplier` upgrade (spec §5C). */
export function effectiveSpread(content: Content, modifiers: ModifierMap): number {
  const fee = modifierOf(modifiers, 'marketFeeMultiplier', IDENTITY);
  return clamp(content.market.model.spread * fee, NONE, IDENTITY);
}

function quoteFrom(
  content: Content,
  material: MaterialDef,
  listing: MarketListing | undefined,
  marketState: MarketMaterialState,
  designMinutes: number,
  seed: number,
  spread: number,
): MarketQuote {
  if (listing === undefined) {
    // No listing: a flat shelf price, and nothing the player can sell back.
    return {
      materialId: material.id,
      tradeable: false,
      multiplier: IDENTITY,
      buyPerGram: material.costPerGram,
      sellPerGram: NONE,
      stockGrams: Number.POSITIVE_INFINITY,
      pressure: NONE,
    };
  }
  const multiplier = priceMultiplier(
    content.market.model,
    material.id,
    designMinutes,
    marketState.pressure,
    seed,
  );
  const buyPerGram = listing.basePricePerGram * multiplier;
  return {
    materialId: material.id,
    tradeable: true,
    multiplier,
    buyPerGram,
    sellPerGram: buyPerGram * (IDENTITY - spread),
    stockGrams: marketState.stockGrams,
    pressure: marketState.pressure,
  };
}

/** What the market is asking for `materialId` right now. */
export function quoteFor(
  state: GameState,
  content: Content,
  materialId: string,
): MarketQuote | null {
  const material = indexById(content.materials).get(materialId);
  if (material === undefined) {
    return null;
  }
  const spread = effectiveSpread(content, computeModifiers(state, content));
  return quoteFrom(
    content,
    material,
    marketListing(content, materialId),
    marketStateOf(state, materialId),
    designMinutesOf(state),
    state.rng.seed,
    spread,
  );
}

/** Every material's current quote — the HUD's market board and the bots' input. */
export function quoteAll(state: GameState, content: Content): readonly MarketQuote[] {
  const spread = effectiveSpread(content, computeModifiers(state, content));
  const designMinutes = designMinutesOf(state);
  return content.materials.map((material) =>
    quoteFrom(
      content,
      material,
      marketListing(content, material.id),
      marketStateOf(state, material.id),
      designMinutes,
      state.rng.seed,
      spread,
    ),
  );
}

/**
 * How many grams `money` buys at the *displayed* ask. This ignores the buy's
 * own slippage, so it is an upper bound — use {@link maxBuyableGrams} to size
 * an order you actually intend to place.
 */
export function affordableGrams(quote: MarketQuote, money: number): number {
  const affordable = quote.buyPerGram > NONE ? money / quote.buyPerGram : Number.POSITIVE_INFINITY;
  return Math.min(affordable, quote.stockGrams);
}

function withMarket(
  market: MarketLedger,
  materialId: string,
  next: MarketMaterialState,
): MarketLedger {
  return { ...market, [materialId]: next };
}

export interface TradeResult {
  readonly state: GameState;
  readonly grams: number;
  /** Money that changed hands (positive in both directions). */
  readonly money: number;
  readonly pricePerGram: number;
}

function pressureStep(content: Content, grams: number): number {
  return grams / content.market.model.pressureScaleGrams;
}

interface BuyProjection {
  readonly pricePerGram: number;
  readonly market: MarketLedger;
}

/** Where the book ends up and what the fill costs, for an order of `grams`. */
function projectBuy(
  state: GameState,
  content: Content,
  materialId: string,
  grams: number,
): BuyProjection | null {
  const material = indexById(content.materials).get(materialId);
  if (material === undefined || !Number.isFinite(grams) || grams <= NONE) {
    return null;
  }
  if (material.supply === 'printed') {
    // Not for sale at any price — you make this one yourself.
    return null;
  }
  const listing = marketListing(content, materialId);
  const spread = effectiveSpread(content, computeModifiers(state, content));
  const before = marketStateOf(state, materialId);

  if (listing === undefined) {
    const quote = quoteFrom(
      content,
      material,
      undefined,
      before,
      designMinutesOf(state),
      state.rng.seed,
      spread,
    );
    return { pricePerGram: quote.buyPerGram, market: state.market };
  }

  if (grams > before.stockGrams) {
    return null;
  }
  const after: MarketMaterialState = {
    stockGrams: before.stockGrams - grams,
    pressure: before.pressure - pressureStep(content, grams),
  };
  const quote = quoteFrom(
    content,
    material,
    listing,
    after,
    designMinutesOf(state),
    state.rng.seed,
    spread,
  );
  return { pricePerGram: quote.buyPerGram, market: withMarket(state.market, materialId, after) };
}

/** What an order of `grams` would actually be filled at, slippage included. */
export function buyFillPricePerGram(
  state: GameState,
  content: Content,
  materialId: string,
  grams: number,
): number | null {
  return projectBuy(state, content, materialId, grams)?.pricePerGram ?? null;
}

/**
 * The largest order `money` can actually pay for.
 *
 * Not `money / price`: a buy moves the price it is filled at (see the header),
 * so an order sized off the displayed ask is rejected for being a few coins
 * short. Total cost rises monotonically with size — more grams at a price that
 * is itself non-decreasing — so a bisection finds the true ceiling.
 */
export function maxBuyableGrams(
  state: GameState,
  content: Content,
  materialId: string,
  money: number,
): number {
  const costOf = (grams: number): number | null => {
    const price = buyFillPricePerGram(state, content, materialId, grams);
    return price === null ? null : price * grams;
  };
  const material = indexById(content.materials).get(materialId);
  const quote = quoteFor(state, content, materialId);
  if (material === undefined || quote === null || material.supply === 'printed') {
    return NONE;
  }
  // `affordableGrams` already caps at the shelf's stock, which is unbounded for
  // an unlisted material — and an unlisted material has no slippage to solve
  // for, so the displayed ask *is* the fill price.
  const ceiling = affordableGrams(quote, money);
  if (!quote.tradeable || !Number.isFinite(ceiling) || ceiling <= NONE) {
    return Math.max(ceiling, NONE);
  }
  const full = costOf(ceiling);
  if (full !== null && full <= money) {
    return ceiling;
  }
  let lo = NONE;
  let hi = ceiling;
  for (let step = NONE; step < TRADE_SEARCH_ITERATIONS; step += IDENTITY) {
    const mid = (lo + hi) / (IDENTITY + IDENTITY);
    const cost = costOf(mid);
    if (cost !== null && cost <= money) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Buy filament (spec §2/§7.2). Infinite-supply materials are a flat shelf
 * price; listed ones move the market first and are then filled at the price
 * they moved to.
 */
export function purchaseFilament(
  state: GameState,
  content: Content,
  materialId: string,
  grams: number,
): TradeResult | null {
  const projected = projectBuy(state, content, materialId, grams);
  if (projected === null) {
    return null;
  }
  return settleBuy(state, materialId, grams, projected.pricePerGram, projected.market);
}

function settleBuy(
  state: GameState,
  materialId: string,
  grams: number,
  pricePerGram: number,
  market: MarketLedger,
): TradeResult | null {
  const money = pricePerGram * grams;
  if (state.resources.money < money) {
    return null;
  }
  return {
    grams,
    money,
    pricePerGram,
    state: {
      ...state,
      market,
      resources: withResource(state.resources, 'money', -money),
      filamentGrams: withFilament(state.filamentGrams, materialId, grams),
      stats: {
        ...state.stats,
        filamentPurchasedGrams: state.stats.filamentPurchasedGrams + grams,
      },
    },
  };
}

/**
 * Sell filament back (spec §7.2). Only listed materials have a buyer, the sale
 * floods the market before it is priced, and the house keeps the spread — so
 * `buy` then `sell` is always a loss, however the price happens to be moving.
 */
export function sellFilamentToMarket(
  state: GameState,
  content: Content,
  materialId: string,
  grams: number,
): TradeResult | null {
  const material = indexById(content.materials).get(materialId);
  const listing = marketListing(content, materialId);
  if (material === undefined || listing === undefined) {
    return null;
  }
  if (
    !Number.isFinite(grams) ||
    grams <= NONE ||
    (state.filamentGrams[materialId] ?? NONE) < grams
  ) {
    return null;
  }
  const before = marketStateOf(state, materialId);
  const after: MarketMaterialState = {
    stockGrams: before.stockGrams + grams,
    pressure: before.pressure + pressureStep(content, grams),
  };
  const spread = effectiveSpread(content, computeModifiers(state, content));
  const quote = quoteFrom(
    content,
    material,
    listing,
    after,
    designMinutesOf(state),
    state.rng.seed,
    spread,
  );
  const money = quote.sellPerGram * grams;
  return {
    grams,
    money,
    pricePerGram: quote.sellPerGram,
    state: {
      ...state,
      market: withMarket(state.market, materialId, after),
      resources: withResource(state.resources, 'money', money),
      filamentGrams: withFilament(state.filamentGrams, materialId, -grams),
      stats: {
        ...state.stats,
        filamentSoldGrams: state.stats.filamentSoldGrams + grams,
        moneyEarned: state.stats.moneyEarned + money,
      },
    },
  };
}

/**
 * Restock and let the player's footprint fade. Pressure decays geometrically,
 * `remaining^minutes`, which is exactly time-additive: decaying for `a + b`
 * minutes equals decaying for `a` and then for `b`, so offline catch-up and
 * live play agree to the last digit (spec §13).
 */
export function tickMarket(state: GameState, content: Content, dtMs: number): GameState {
  const minutes = dtMs / MS_PER_MINUTE;
  if (minutes <= NONE) {
    return state;
  }
  const decay = (IDENTITY - content.market.model.pressureDecayPerDesignMinute) ** minutes;
  let changed = false;
  const market: Record<string, MarketMaterialState> = { ...state.market };
  for (const listing of content.market.listings) {
    const current = marketStateOf(state, listing.materialId);
    const restocked =
      current.stockGrams < listing.stockGrams
        ? Math.min(
            listing.stockGrams,
            current.stockGrams + listing.restockGramsPerDesignMinute * minutes,
          )
        : current.stockGrams;
    const next: MarketMaterialState = { stockGrams: restocked, pressure: current.pressure * decay };
    if (next.stockGrams !== current.stockGrams || next.pressure !== current.pressure) {
      changed = true;
    }
    market[listing.materialId] = next;
  }
  return changed ? { ...state, market } : state;
}
