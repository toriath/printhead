import { describe, expect, it } from 'vitest';
import { MS_PER_SECOND } from '../engine/constants.js';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { customerIntervalMs, isShopOpen, priceLevel, setShopPriceLevel, tickShop } from './shop.js';

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 3 });
const shop = content.shop;
const level = (id: string) => {
  const found = priceLevel(content, id);
  if (found === undefined) {
    throw new Error(`no price level ${id}`);
  }
  return found;
};
/** In the bench, open at a price, with stock on the shelf. */
function open(priceLevelId: string, parts: number): GameState {
  const bench = { ...base, phaseId: 'shop' };
  const priced = setShopPriceLevel(bench, content, priceLevelId) ?? bench;
  return {
    ...priced,
    resources: { ...priced.resources, parts },
    partsValue: parts * 0.5,
  };
}

describe('the shop front', () => {
  it('stays shut before its phase, and opens shut', () => {
    expect(isShopOpen(base, content)).toBe(false);
    expect(base.shop.priceLevelId).toBe(shop.openingPriceLevel);
    expect(setShopPriceLevel(base, content, 'fair')).toBeNull();
    const shut = { ...base, phaseId: 'shop', resources: { ...base.resources, parts: 50 } };
    expect(tickShop(shut, content, 10 * 60 * MS_PER_SECOND, undefined).resources.parts).toBe(50);
  });

  it('sells stock over the counter for more than wholesale, and gains reputation', () => {
    const state = open('fair', 50);
    const { result, events } = collectEvents((emit) =>
      tickShop(state, content, state.shop.nextCustomerMs, emit),
    );
    const served = events.find((event) => event.type === 'CUSTOMER_SERVED');
    expect(served).toBeDefined();
    if (served?.type !== 'CUSTOMER_SERVED') {
      throw new Error('expected a sale');
    }
    expect(served.money).toBeCloseTo(served.parts * 0.5 * level('fair').priceMultiplier, 9);
    expect(result.resources.parts).toBe(50 - served.parts);
    expect(result.shop.reputation).toBeGreaterThan(state.shop.reputation);
    expect(result.stats.customersServed).toBe(1);
  });

  it('sends a customer away from an empty shelf, at a cost to its name', () => {
    const state = open('fair', 0);
    const { result, events } = collectEvents((emit) =>
      tickShop(state, content, state.shop.nextCustomerMs, emit),
    );
    expect(events.some((event) => event.type === 'CUSTOMER_LEFT')).toBe(true);
    expect(result.shop.reputation).toBeLessThan(state.shop.reputation);
    expect(result.stats.customersMissed).toBe(1);
  });

  it('trades margin for footfall: dearer means fewer customers', () => {
    expect(customerIntervalMs(content, level('premium'), 0.5)).toBeGreaterThan(
      customerIntervalMs(content, level('fair'), 0.5),
    );
    expect(customerIntervalMs(content, level('bargain'), 0.5)).toBeLessThan(
      customerIntervalMs(content, level('fair'), 0.5),
    );
    // A good name brings people in.
    expect(customerIntervalMs(content, level('fair'), 1)).toBeLessThan(
      customerIntervalMs(content, level('fair'), 0),
    );
    expect(customerIntervalMs(content, level('closed'), 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('sees the same customers on every replay', () => {
    const state = open('bargain', 500);
    const hour = 60 * 60 * MS_PER_SECOND;
    expect(tickShop(state, content, hour, undefined)).toEqual(
      tickShop(state, content, hour, undefined),
    );
  });
});
