import { describe, expect, it } from 'vitest';
import type { AutomationDef, Content } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import {
  automationAvailability,
  automationLevel,
  automationStateOf,
  configureAutomation,
  countAutomations,
  isAutomationActive,
  nextAutomationCost,
  purchaseAutomation,
  tickAutomation,
} from './automation.js';

const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });
const AUTO_SELL = 'auto-sell';
const AUTO_BUY = 'auto-buy-filament';
const AUTO_TRADE = 'auto-trade';

const defOf = (id: string): AutomationDef => {
  const def = content.automation.find((candidate) => candidate.id === id);
  if (def === undefined) {
    throw new Error(`missing automation def: ${id}`);
  }
  return def;
};

const installed = (
  id: string,
  over: Partial<{ enabled: boolean; threshold: number; cooldownMs: number }> = {},
) => ({
  [id]: {
    level: 1,
    enabled: true,
    threshold: defOf(id).defaultThreshold,
    cooldownMs: defOf(id).intervalDesignSeconds * MS_PER_SECOND,
    ...over,
  },
});

const inBench = (over: Partial<GameState> = {}): GameState => ({
  ...base,
  phaseId: 'bench',
  ...over,
});

describe('ownership', () => {
  it('reports level, activity and the total installed', () => {
    expect(automationLevel(base, AUTO_SELL)).toBe(0);
    expect(automationStateOf(base, AUTO_SELL)).toBeUndefined();
    expect(isAutomationActive(base, AUTO_SELL)).toBe(false);

    const owned = inBench({ automation: installed(AUTO_SELL) });
    expect(automationLevel(owned, AUTO_SELL)).toBe(1);
    expect(isAutomationActive(owned, AUTO_SELL)).toBe(true);
    expect(countAutomations(owned)).toBe(1);

    const off = inBench({ automation: installed(AUTO_SELL, { enabled: false }) });
    expect(isAutomationActive(off, AUTO_SELL)).toBe(false);
  });
});

describe('automationAvailability', () => {
  it('names the exact reason it cannot be bought', () => {
    expect(automationAvailability(base, content, 'ghost')).toBe('unknown-target');
    expect(automationAvailability(base, content, AUTO_SELL)).toBe('locked');
    expect(automationAvailability(inBench(), content, AUTO_SELL)).toBeNull();
    expect(
      automationAvailability(inBench({ automation: installed(AUTO_SELL) }), content, AUTO_SELL),
    ).toBe('max-level');
    // The trading desk needs a broker licence first (spec §5C).
    const inFarm = inBench({ phaseId: 'farm' });
    expect(automationAvailability(inFarm, content, AUTO_TRADE)).toBe('missing-prerequisite');
    expect(
      automationAvailability({ ...inFarm, upgrades: { 'broker-licence': 1 } }, content, AUTO_TRADE),
    ).toBeNull();
  });
});

describe('purchaseAutomation', () => {
  it('pays the curve price and seeds the def default threshold', () => {
    const cost = nextAutomationCost(inBench(), content, curves, AUTO_SELL);
    expect(Number.isInteger(cost?.amount)).toBe(true);
    const rich = inBench({
      resources: { ...base.resources, parts: cost?.amount ?? 0 },
      partsValue: cost?.amount ?? 0,
    });
    const bought = purchaseAutomation(rich, content, curves, AUTO_SELL);
    expect(bought?.level).toBe(1);
    const owned = bought?.state.automation[AUTO_SELL];
    expect(owned?.threshold).toBe(defOf(AUTO_SELL).defaultThreshold);
    expect(owned?.enabled).toBe(true);
    // It waits out a full interval before its first firing.
    expect(owned?.cooldownMs).toBe(defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND);
  });

  it('is null when unaffordable or unknown', () => {
    expect(purchaseAutomation(inBench(), content, curves, AUTO_SELL)).toBeNull();
    expect(purchaseAutomation(inBench(), content, curves, 'ghost')).toBeNull();
    expect(nextAutomationCost(inBench(), content, curves, 'ghost')).toBeNull();
  });
});

describe('configureAutomation', () => {
  it('flips the switch and moves the threshold', () => {
    const owned = inBench({ automation: installed(AUTO_SELL) });
    const off = configureAutomation(owned, AUTO_SELL, { enabled: false });
    expect(off?.automation[AUTO_SELL]?.enabled).toBe(false);
    // ...leaving the threshold alone.
    expect(off?.automation[AUTO_SELL]?.threshold).toBe(defOf(AUTO_SELL).defaultThreshold);
    expect(
      configureAutomation(owned, AUTO_SELL, { threshold: 7 })?.automation[AUTO_SELL]?.threshold,
    ).toBe(7);
  });

  it('refuses an automation that is not installed, and a nonsense threshold', () => {
    expect(configureAutomation(base, AUTO_SELL, { enabled: true })).toBeNull();
    const owned = inBench({ automation: installed(AUTO_SELL) });
    expect(configureAutomation(owned, AUTO_SELL, { threshold: -1 })).toBeNull();
    expect(configureAutomation(owned, AUTO_SELL, { threshold: Number.NaN })).toBeNull();
  });
});

describe('tickAutomation', () => {
  const holding = (parts: number, over: Partial<GameState> = {}): GameState =>
    inBench({ resources: { ...base.resources, parts }, partsValue: parts, ...over });

  it('does nothing until the interval elapses', () => {
    const state = holding(100, { automation: installed(AUTO_SELL) });
    const early = tickAutomation(state, content, MS_PER_SECOND, undefined);
    expect(early.resources.parts).toBe(100);
    expect(early.automation[AUTO_SELL]?.cooldownMs).toBeLessThan(
      state.automation[AUTO_SELL]?.cooldownMs ?? 0,
    );
  });

  it('sells only the surplus above the threshold, so savings survive', () => {
    const threshold = 40;
    const state = holding(100, { automation: installed(AUTO_SELL, { threshold }) });
    const fired = tickAutomation(
      state,
      content,
      defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND,
      undefined,
    );
    expect(fired.resources.parts).toBe(threshold);
    expect(fired.resources.money).toBeGreaterThan(0);
  });

  it('holds off entirely while the pile is under the threshold', () => {
    const state = holding(10, { automation: installed(AUTO_SELL, { threshold: 40 }) });
    const fired = tickAutomation(
      state,
      content,
      defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND,
      undefined,
    );
    expect(fired.resources.parts).toBe(10);
    expect(fired.resources.money).toBe(0);
  });

  it('stays quiet when it is switched off', () => {
    const state = holding(100, { automation: installed(AUTO_SELL, { enabled: false }) });
    const fired = tickAutomation(
      state,
      content,
      defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND,
      undefined,
    );
    expect(fired.resources.parts).toBe(100);
  });

  it('announces a firing that actually changed something, and only then', () => {
    const interval = defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND;
    const busy = holding(100, { automation: installed(AUTO_SELL, { threshold: 40 }) });
    const quiet = holding(1, { automation: installed(AUTO_SELL, { threshold: 40 }) });
    const loud = collectEvents((emit) => tickAutomation(busy, content, interval, emit));
    const silent = collectEvents((emit) => tickAutomation(quiet, content, interval, emit));
    expect(loud.events.some((event) => event.type === 'AUTOMATION_FIRED')).toBe(true);
    expect(silent.events.some((event) => event.type === 'AUTOMATION_FIRED')).toBe(false);
  });

  it('carries the overshoot forward instead of resetting the timer', () => {
    const interval = defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND;
    const state = holding(0, { automation: installed(AUTO_SELL) });
    const fired = tickAutomation(state, content, interval + 400, undefined);
    expect(fired.automation[AUTO_SELL]?.cooldownMs).toBe(interval - 400);
  });

  it('catches up on several missed intervals in one oversized tick', () => {
    const interval = defOf(AUTO_SELL).intervalDesignSeconds * MS_PER_SECOND;
    const state = holding(0, { automation: installed(AUTO_SELL) });
    const fired = tickAutomation(state, content, interval * 4, undefined);
    expect(fired.automation[AUTO_SELL]?.cooldownMs).toBe(interval);
  });

  it('ignores defs the player has never bought', () => {
    const state = holding(100);
    expect(tickAutomation(state, content, MS_PER_SECOND * 1000, undefined)).toBe(state);
  });

  describe('auto-buy filament', () => {
    const stocked = (money: number, grams: number): GameState =>
      inBench({
        resources: { ...base.resources, money },
        filamentGrams: { ...base.filamentGrams, pla: grams },
        slots: [testSlot({ materialId: 'pla', objectId: 'bracket', printerCount: 1 })],
        automation: installed(AUTO_BUY),
      });

    it('tops the loaded material up towards the threshold', () => {
      const state = stocked(100, 0);
      const fired = tickAutomation(
        state,
        content,
        defOf(AUTO_BUY).intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.filamentGrams.pla).toBeGreaterThan(0);
      expect(fired.filamentGrams.pla).toBeLessThanOrEqual(defOf(AUTO_BUY).defaultThreshold);
      expect(fired.resources.money).toBeLessThan(100);
    });

    it('leaves the money reserve untouched', () => {
      const def = defOf(AUTO_BUY);
      const reserve = def.behavior === 'buy-filament' ? def.moneyReserve : 0;
      const state = stocked(reserve, 0);
      const fired = tickAutomation(
        state,
        content,
        def.intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.resources.money).toBe(reserve);
      expect(fired.filamentGrams.pla).toBe(0);
    });

    it('does nothing once the spool is already full, or the slot is empty', () => {
      const full = stocked(100, defOf(AUTO_BUY).defaultThreshold);
      const interval = defOf(AUTO_BUY).intervalDesignSeconds * MS_PER_SECOND;
      expect(tickAutomation(full, content, interval, undefined).resources.money).toBe(100);

      const empty: GameState = { ...stocked(100, 0), slots: [testSlot()] };
      expect(tickAutomation(empty, content, interval, undefined).resources.money).toBe(100);
    });
  });

  describe('auto-trading desk', () => {
    const trading = (over: Partial<GameState> = {}): GameState =>
      inBench({
        phaseId: 'farm',
        upgrades: { 'broker-licence': 1, 'heated-bed': 1 },
        automation: installed(AUTO_TRADE),
        ...over,
      });

    /**
     * The desk reacts to a *price*, so the test pins the price rather than the
     * clock: a flat market with the multiplier forced under the buy trigger.
     */
    const forced = (multiplier: number): Content => ({
      ...content,
      market: {
        ...content.market,
        model: {
          ...content.market.model,
          sineAmplitude: 0,
          noiseAmplitude: 0,
          minPriceMultiplier: multiplier,
          maxPriceMultiplier: multiplier,
        },
      },
    });

    it('buys a parcel when the price is under its trigger', () => {
      const cheap = forced(0.5);
      const state = trading({ resources: { ...base.resources, money: 10_000 } });
      const fired = tickAutomation(
        state,
        cheap,
        defOf(AUTO_TRADE).intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.filamentGrams.petg ?? 0).toBeGreaterThan(0);
      expect(fired.stats.filamentPurchasedGrams).toBeGreaterThan(0);
    });

    it('sells its holding back when the price is over its trigger', () => {
      const dear = forced(1.8);
      const state = trading({
        filamentGrams: { ...base.filamentGrams, petg: 1000 },
      });
      const fired = tickAutomation(
        state,
        dear,
        defOf(AUTO_TRADE).intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.stats.filamentSoldGrams).toBeGreaterThan(0);
      expect(fired.resources.money).toBeGreaterThan(0);
    });

    it('sits on its hands between the two triggers', () => {
      const middling = forced(1);
      const state = trading({ resources: { ...base.resources, money: 10_000 } });
      const fired = tickAutomation(
        state,
        middling,
        defOf(AUTO_TRADE).intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.stats.filamentPurchasedGrams).toBe(0);
      expect(fired.stats.filamentSoldGrams).toBe(0);
    });

    it('refuses to exceed its holding cap however cheap the market gets', () => {
      const def = defOf(AUTO_TRADE);
      const cap = def.behavior === 'trade-filament' ? def.maxHoldingGrams : 0;
      const cheap = forced(0.5);
      const state = trading({
        resources: { ...base.resources, money: 1_000_000 },
        filamentGrams: { ...base.filamentGrams, petg: cap },
      });
      const fired = tickAutomation(
        state,
        cheap,
        def.intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.filamentGrams.petg).toBe(cap);
    });

    it('skips materials whose listing has not unlocked yet', () => {
      const cheap = forced(0.5);
      // Resin lists in farm, metal only in prestige.
      const state = trading({ resources: { ...base.resources, money: 1_000_000 } });
      const fired = tickAutomation(
        state,
        cheap,
        defOf(AUTO_TRADE).intervalDesignSeconds * MS_PER_SECOND,
        undefined,
      );
      expect(fired.filamentGrams.metal ?? 0).toBe(0);
    });
  });
});
