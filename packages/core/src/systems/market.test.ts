import { describe, expect, it } from 'vitest';
import type { Content, MarketModel } from '../content/schema.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  buyFillPricePerGram,
  effectiveSpread,
  marketListing,
  marketStateOf,
  maxBuyableGrams,
  priceMultiplier,
  purchaseFilament,
  quoteAll,
  quoteFor,
  sellFilamentToMarket,
  tickMarket,
} from './market.js';
import { computeModifiers } from './upgrades.js';

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 1 });
const model = content.market.model;
const TRADED = 'petg';
const UNLISTED = 'pla';

const rich = (money: number, over: Partial<GameState> = {}): GameState => ({
  ...base,
  resources: { ...base.resources, money },
  ...over,
});

describe('priceMultiplier', () => {
  it('is flat under the flat strategy, whatever the time and pressure', () => {
    const flat: MarketModel = { ...model, strategy: 'flat' };
    expect(priceMultiplier(flat, TRADED, 0, 0, 1)).toBe(1);
    expect(priceMultiplier(flat, TRADED, 37.5, 0.9, 1)).toBe(1);
  });

  it('stays inside the configured bounds however hard it is pushed', () => {
    for (const pressure of [-1000, -1, 0, 1, 1000]) {
      for (const minutes of [0, 3.3, 17, 420]) {
        const multiplier = priceMultiplier(model, TRADED, minutes, pressure, 1);
        expect(multiplier).toBeGreaterThanOrEqual(model.minPriceMultiplier);
        expect(multiplier).toBeLessThanOrEqual(model.maxPriceMultiplier);
      }
    }
  });

  it('falls when the player floods the market (spec §7.2)', () => {
    const calm = priceMultiplier(
      { ...model, sineAmplitude: 0, noiseAmplitude: 0 },
      TRADED,
      0,
      0,
      1,
    );
    const flooded = priceMultiplier(
      { ...model, sineAmplitude: 0, noiseAmplitude: 0 },
      TRADED,
      0,
      0.5,
      1,
    );
    expect(flooded).toBeLessThan(calm);
  });

  it('is a pure function of (seed, time, pressure) — no stream is consumed', () => {
    const once = priceMultiplier(model, TRADED, 12.25, 0.1, 42);
    const twice = priceMultiplier(model, TRADED, 12.25, 0.1, 42);
    expect(twice).toBe(once);
    expect(priceMultiplier(model, TRADED, 12.25, 0.1, 43)).not.toBe(once);
  });

  it('gives each material its own phase, so they do not move in lockstep', () => {
    const petg = priceMultiplier(model, 'petg', 3, 0, 1);
    const resin = priceMultiplier(model, 'resin', 3, 0, 1);
    expect(petg).not.toBeCloseTo(resin, 6);
  });

  it('holds a noise sample for a whole step before redrawing', () => {
    const quiet: MarketModel = { ...model, sineAmplitude: 0 };
    const step = quiet.noiseStepDesignMinutes;
    expect(priceMultiplier(quiet, TRADED, 0, 0, 1)).toBe(
      priceMultiplier(quiet, TRADED, step * 0.99, 0, 1),
    );
    expect(priceMultiplier(quiet, TRADED, 0, 0, 1)).not.toBe(
      priceMultiplier(quiet, TRADED, step, 0, 1),
    );
  });
});

describe('quotes', () => {
  it('prices an unlisted material off its flat shelf cost, with no buyer', () => {
    const quote = quoteFor(base, content, UNLISTED);
    expect(quote?.tradeable).toBe(false);
    expect(quote?.buyPerGram).toBe(content.materials[0]?.costPerGram);
    expect(quote?.sellPerGram).toBe(0);
    expect(quote?.stockGrams).toBe(Number.POSITIVE_INFINITY);
  });

  it('always pays less than it charges — the house keeps the spread', () => {
    const quote = quoteFor(base, content, TRADED);
    expect(quote?.sellPerGram).toBeLessThan(quote?.buyPerGram ?? 0);
    expect(quote?.sellPerGram).toBeCloseTo((quote?.buyPerGram ?? 0) * (1 - model.spread), 9);
  });

  it('narrows the spread when a broker licence is installed', () => {
    const licensed: GameState = { ...base, upgrades: { 'broker-licence': 1 } };
    expect(effectiveSpread(content, computeModifiers(licensed, content))).toBeLessThan(
      effectiveSpread(content, computeModifiers(base, content)),
    );
  });

  it('quotes every material at once for the HUD', () => {
    expect(quoteAll(base, content).map((quote) => quote.materialId)).toEqual(
      content.materials.map((material) => material.id),
    );
  });

  it('is null for a material that does not exist', () => {
    expect(quoteFor(base, content, 'unobtainium')).toBeNull();
    expect(marketListing(content, 'unobtainium')).toBeUndefined();
  });

  it('treats a material with no market entry as empty stock', () => {
    expect(marketStateOf(base, 'unobtainium')).toEqual({ stockGrams: 0, pressure: 0 });
  });
});

describe('buying', () => {
  it('exchanges money for grams and books the stat', () => {
    const bought = purchaseFilament(rich(10), content, UNLISTED, 100);
    expect(bought?.grams).toBe(100);
    expect(bought?.state.filamentGrams[UNLISTED]).toBe((base.filamentGrams[UNLISTED] ?? 0) + 100);
    expect(bought?.state.stats.filamentPurchasedGrams).toBe(100);
    expect(bought?.state.resources.money).toBeCloseTo(10 - (bought?.money ?? 0), 9);
  });

  it('refuses an unaffordable order rather than going into debt', () => {
    expect(purchaseFilament(rich(1), content, UNLISTED, 1_000_000)).toBeNull();
  });

  it('refuses unknown materials and nonsensical quantities', () => {
    expect(purchaseFilament(rich(1000), content, 'unobtainium', 10)).toBeNull();
    expect(purchaseFilament(rich(1000), content, UNLISTED, 0)).toBeNull();
    expect(purchaseFilament(rich(1000), content, UNLISTED, -10)).toBeNull();
    expect(purchaseFilament(rich(1000), content, UNLISTED, Number.NaN)).toBeNull();
    expect(purchaseFilament(rich(1000), content, UNLISTED, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('refuses a material you are supposed to print rather than buy', () => {
    const printed: Content = {
      ...content,
      materials: content.materials.map((material) =>
        material.id === UNLISTED ? { ...material, supply: 'printed' } : material,
      ),
    };
    expect(purchaseFilament(rich(1000), printed, UNLISTED, 10)).toBeNull();
    expect(maxBuyableGrams(rich(1000), printed, UNLISTED, 1000)).toBe(0);
  });

  it('cannot buy more than the shelf holds', () => {
    const stock = marketStateOf(base, TRADED).stockGrams;
    expect(purchaseFilament(rich(1_000_000), content, TRADED, stock + 1)).toBeNull();
    expect(purchaseFilament(rich(1_000_000), content, TRADED, stock)).not.toBeNull();
  });

  it('draws the shelf down and pushes the price up', () => {
    const before = quoteFor(base, content, TRADED);
    const bought = purchaseFilament(rich(1_000_000), content, TRADED, 2000);
    const after = quoteFor(bought?.state as GameState, content, TRADED);
    expect(after?.stockGrams).toBe((before?.stockGrams ?? 0) - 2000);
    expect(after?.multiplier).toBeGreaterThan(before?.multiplier ?? 0);
  });

  it('fills a big order above the displayed ask — the trade pays its slippage', () => {
    const displayed = quoteFor(base, content, TRADED)?.buyPerGram ?? 0;
    const filled = buyFillPricePerGram(base, content, TRADED, 3000) ?? 0;
    expect(filled).toBeGreaterThan(displayed);
    expect(buyFillPricePerGram(base, content, TRADED, 1e9)).toBeNull();
  });
});

describe('maxBuyableGrams', () => {
  it('sizes an order the market will actually accept', () => {
    const money = 200;
    const grams = maxBuyableGrams(rich(money), content, TRADED, money);
    expect(grams).toBeGreaterThan(0);
    // The whole point: an order of exactly this size must not be refused.
    expect(purchaseFilament(rich(money), content, TRADED, Math.floor(grams))).not.toBeNull();
    // ...and it really is close to the ceiling.
    expect(purchaseFilament(rich(money), content, TRADED, Math.ceil(grams) + 1)).toBeNull();
  });

  it('needs no search for an unlisted material — there is no slippage', () => {
    const perGram = content.materials[0]?.costPerGram ?? 1;
    expect(maxBuyableGrams(rich(10), content, UNLISTED, 10)).toBeCloseTo(10 / perGram, 6);
  });

  it('is zero with no money, and for a material that does not exist', () => {
    expect(maxBuyableGrams(rich(0), content, TRADED, 0)).toBe(0);
    expect(maxBuyableGrams(rich(10), content, 'unobtainium', 10)).toBe(0);
  });

  it('is capped by the shelf, not only by the wallet', () => {
    const stock = marketStateOf(base, TRADED).stockGrams;
    expect(maxBuyableGrams(rich(1e9), content, TRADED, 1e9)).toBeLessThanOrEqual(stock);
  });
});

describe('selling', () => {
  const holding = (grams: number): GameState => ({
    ...base,
    filamentGrams: { ...base.filamentGrams, [TRADED]: grams },
  });

  it('pays out, restocks the shelf and books the stat', () => {
    const sold = sellFilamentToMarket(holding(500), content, TRADED, 200);
    expect(sold?.grams).toBe(200);
    expect(sold?.money).toBeGreaterThan(0);
    expect(sold?.state.filamentGrams[TRADED]).toBe(300);
    expect(sold?.state.stats.filamentSoldGrams).toBe(200);
    expect(sold?.state.market[TRADED]?.stockGrams).toBe(
      marketStateOf(base, TRADED).stockGrams + 200,
    );
  });

  it('refuses unlisted materials — nobody is buying PLA back', () => {
    expect(sellFilamentToMarket(holding(500), content, UNLISTED, 10)).toBeNull();
  });

  it('refuses grams you do not have, and nonsense quantities', () => {
    expect(sellFilamentToMarket(holding(5), content, TRADED, 10)).toBeNull();
    expect(sellFilamentToMarket(holding(500), content, TRADED, 0)).toBeNull();
    expect(sellFilamentToMarket(holding(500), content, TRADED, Number.NaN)).toBeNull();
    expect(sellFilamentToMarket(holding(500), content, 'unobtainium', 10)).toBeNull();
  });

  /**
   * The mirror of the buy-side slippage rule: a sale is filled at the price it
   * pushed *down* to, not at the price on the board when it was placed. The
   * round-trip property cannot see this on its own (pricing a sell early is
   * still a loss once the spread is paid), so it gets its own assertion.
   */
  it('fills a big sale below the displayed bid — the sale pays its slippage', () => {
    const displayed = quoteFor(holding(4000), content, TRADED)?.sellPerGram ?? 0;
    const sold = sellFilamentToMarket(holding(4000), content, TRADED, 4000);
    expect(sold?.pricePerGram).toBeLessThan(displayed);
  });

  it('floods the market: selling pushes the price down (spec §7.2)', () => {
    const before = quoteFor(holding(4000), content, TRADED);
    const sold = sellFilamentToMarket(holding(4000), content, TRADED, 4000);
    const after = quoteFor(sold?.state as GameState, content, TRADED);
    expect(after?.multiplier).toBeLessThan(before?.multiplier ?? 0);
  });

  /**
   * The invariant the whole slippage-before-pricing rule exists for (spec §13).
   * Property-based coverage lives in `state/properties.test.ts`; this is the
   * worked example that makes the intent legible.
   */
  it('a buy followed by an immediate sell always loses money', () => {
    const start = rich(1000);
    const bought = purchaseFilament(start, content, TRADED, 2000);
    const sold = sellFilamentToMarket(bought?.state as GameState, content, TRADED, 2000);
    expect(sold?.state.resources.money).toBeLessThan(start.resources.money);
  });
});

describe('tickMarket', () => {
  it('restocks towards the listing capacity but never past it', () => {
    const drained: GameState = {
      ...base,
      market: { ...base.market, [TRADED]: { stockGrams: 0, pressure: 0 } },
    };
    const listing = marketListing(content, TRADED);
    const after = tickMarket(drained, content, MS_PER_MINUTE);
    expect(after.market[TRADED]?.stockGrams).toBeCloseTo(
      listing?.restockGramsPerDesignMinute ?? 0,
      9,
    );
    const full = tickMarket(base, content, MS_PER_MINUTE * 1000);
    expect(full.market[TRADED]?.stockGrams).toBe(listing?.stockGrams);
  });

  it('leaves an over-full shelf alone — the player dumped it there', () => {
    const glut = (marketListing(content, TRADED)?.stockGrams ?? 0) * 2;
    const dumped: GameState = {
      ...base,
      market: { ...base.market, [TRADED]: { stockGrams: glut, pressure: 0 } },
    };
    expect(tickMarket(dumped, content, MS_PER_MINUTE).market[TRADED]?.stockGrams).toBe(glut);
  });

  it('decays pressure geometrically, so the decay is exactly time-additive', () => {
    const pressured: GameState = {
      ...base,
      market: { ...base.market, [TRADED]: { stockGrams: 100, pressure: 1 } },
    };
    const once = tickMarket(pressured, content, MS_PER_MINUTE * 2);
    const twice = tickMarket(tickMarket(pressured, content, MS_PER_MINUTE), content, MS_PER_MINUTE);
    expect(twice.market[TRADED]?.pressure).toBeCloseTo(once.market[TRADED]?.pressure ?? 0, 12);
    expect(once.market[TRADED]?.pressure).toBeLessThan(1);
  });

  it('is a no-op for a zero-length tick', () => {
    expect(tickMarket(base, content, 0)).toBe(base);
  });

  it('returns the same object when nothing actually moved', () => {
    const settled = tickMarket(base, content, MS_PER_MINUTE * 10_000);
    expect(tickMarket(settled, content, MS_PER_MINUTE)).toBe(settled);
  });
});
