import { indexById } from '../content/load.js';
import type { Content } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import type { EventSink } from '../events/types.js';
import { hashUnit } from '../rng/mulberry32.js';
import type { GameState } from '../state/game-state.js';
import { isPhaseReached } from './phases.js';
import { drawParts, removeParts, withResource } from './resources.js';

/**
 * The shop front (content: `shop.json`). Customers walk in on a clock set by
 * the price level and the shop's reputation, each wanting a handful of Parts.
 * Stock on the shelf sells at the retail price; an empty shelf sends them away
 * and costs reputation. The player's levers are the price — margin against
 * footfall — and what they keep in stock rather than selling wholesale.
 *
 * Who walks in and what they want is drawn from a hash of the run's seed and
 * the visit counter, never the rng stream: the shop is a pure function of the
 * save, so a replay sees the same customers.
 */

export type PriceLevel = Content['shop']['priceLevels'][number];

const NONE = 0;
const ONE = 1;

export function isShopOpen(state: GameState, content: Content): boolean {
  return isPhaseReached(content.pacing.phases, state.phaseId, content.shop.unlockPhaseId);
}

export function priceLevel(content: Content, priceLevelId: string): PriceLevel | undefined {
  return indexById(content.shop.priceLevels).get(priceLevelId);
}

/** Customer arrivals per fair-price arrival at this price and reputation. */
export function shopDemand(content: Content, level: PriceLevel, reputation: number): number {
  const { reputationDemandMin, reputationDemandMax } = content.shop;
  const standing = reputationDemandMin + (reputationDemandMax - reputationDemandMin) * reputation;
  return level.demandMultiplier * standing;
}

/** Design-milliseconds between customers; `Infinity` when the shop is shut. */
export function customerIntervalMs(
  content: Content,
  level: PriceLevel,
  reputation: number,
): number {
  const demand = shopDemand(content, level, reputation);
  return demand <= NONE
    ? Number.POSITIVE_INFINITY
    : (content.shop.customerEveryDesignSeconds * MS_PER_SECOND) / demand;
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, NONE), ONE);
}

/** One customer at the counter: they buy what they can, or leave. */
function serveCustomer(
  state: GameState,
  content: Content,
  level: PriceLevel,
  emit: EventSink | undefined,
): GameState {
  const { shop } = content;
  const visit = state.shop.visits;
  const span = shop.partsPerCustomerMax - shop.partsPerCustomerMin + ONE;
  const wanted =
    shop.partsPerCustomerMin + Math.floor(hashUnit(`shop-want:${visit}`, state.rng.seed) * span);
  const customer =
    shop.customers[
      Math.floor(hashUnit(`shop-who:${visit}`, state.rng.seed) * shop.customers.length)
    ];
  const customerId = customer?.id ?? '';
  const visits = visit + ONE;
  if (state.resources.parts < ONE) {
    emit?.({ type: 'CUSTOMER_LEFT', simTimeMs: state.simTimeMs, customerId, wanted });
    return {
      ...state,
      shop: {
        ...state.shop,
        visits,
        reputation: clampUnit(state.shop.reputation - shop.reputationLossPerMiss),
      },
      stats: { ...state.stats, customersMissed: state.stats.customersMissed + ONE },
    };
  }
  const draw = drawParts(state, Math.min(wanted, state.resources.parts));
  const money = draw.value * level.priceMultiplier;
  const sold = removeParts(state, draw);
  emit?.({
    type: 'CUSTOMER_SERVED',
    simTimeMs: state.simTimeMs,
    customerId,
    parts: draw.count,
    money,
  });
  return {
    ...sold,
    resources: withResource(sold.resources, 'money', money),
    shop: {
      ...sold.shop,
      visits,
      reputation: clampUnit(sold.shop.reputation + shop.reputationGainPerSale),
    },
    stats: {
      ...sold.stats,
      partsSold: sold.stats.partsSold + draw.count,
      moneyEarned: sold.stats.moneyEarned + money,
      customersServed: sold.stats.customersServed + ONE,
    },
  };
}

/** Run the shop's clock: every customer due in `dtMs` comes in, in order. */
export function tickShop(
  state: GameState,
  content: Content,
  dtMs: number,
  emit: EventSink | undefined,
): GameState {
  if (!isShopOpen(state, content)) {
    return state;
  }
  const level = priceLevel(content, state.shop.priceLevelId);
  if (level === undefined || level.demandMultiplier <= NONE) {
    return state;
  }
  let next: GameState = {
    ...state,
    shop: { ...state.shop, nextCustomerMs: state.shop.nextCustomerMs - dtMs },
  };
  while (next.shop.nextCustomerMs <= NONE) {
    next = serveCustomer(next, content, level, emit);
    next = {
      ...next,
      shop: {
        ...next.shop,
        nextCustomerMs:
          next.shop.nextCustomerMs + customerIntervalMs(content, level, next.shop.reputation),
      },
    };
  }
  return next;
}

/** Change the price level. A shut shop's clock waits; reopening starts it afresh. */
export function setShopPriceLevel(
  state: GameState,
  content: Content,
  priceLevelId: string,
): GameState | null {
  const level = priceLevel(content, priceLevelId);
  if (level === undefined || !isShopOpen(state, content)) {
    return null;
  }
  const wasShut = (priceLevel(content, state.shop.priceLevelId)?.demandMultiplier ?? NONE) <= NONE;
  return {
    ...state,
    shop: {
      ...state.shop,
      priceLevelId,
      nextCustomerMs:
        wasShut && level.demandMultiplier > NONE
          ? customerIntervalMs(content, level, state.shop.reputation)
          : state.shop.nextCustomerMs,
    },
  };
}
