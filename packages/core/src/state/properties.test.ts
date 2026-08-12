import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { RawContent } from '../content/schema.js';
import { MS_PER_HOUR, MS_PER_MINUTE, TICK_MS } from '../engine/constants.js';
import { runOfflineCatchUp } from '../engine/offline.js';
import { restoreRng } from '../rng/mulberry32.js';
import { deserializeSave, serializeSave } from '../save/serialize.js';
import { marketStateOf, priceMultiplier, quoteFor } from '../systems/market.js';
import { hardSlotMaximum } from '../systems/slots.js';
import { validateVisualState } from '../visual/schema.js';
import { toVisualState } from '../visual/visual-state.js';
import {
  FIRST_MATERIAL_ID,
  FIRST_OBJECT_ID,
  FIRST_SLOT_ID,
  TEST_CONTENT,
  testSlot,
} from './__fixtures__/sim.js';
import type { Action } from './actions.js';
import {
  buyAutomation,
  buyFilament,
  buyPrinter,
  buyUpgrade,
  recycleScrap,
  sellFilament,
  sellParts,
  setAutomation,
  setSlotConfig,
  startPrint,
  tick,
} from './actions.js';
import { type GameState, type ReduceContext, createInitialState } from './game-state.js';
import { reduce } from './reduce.js';

/**
 * The invariants spec §13 names, as properties rather than examples. These are
 * the load-bearing guarantees: a resource that can go negative, an offline
 * catch-up that disagrees with playing online, or a save that does not round
 * trip are all silent, save-corrupting bugs that no single example would catch.
 */
const content = TEST_CONTENT;
const printerId = content.start.printerId;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const contentAt = (targetHours: number) => {
  const raw = clone(RAW_CONTENT) as RawContent;
  (raw.pacing as { targetHours: number }).targetHours = targetHours;
  return loadContent(raw);
};

const apply = (state: GameState, action: Action): GameState => {
  const ctx: ReduceContext = {
    content,
    nowMs: state.simTimeMs,
    rng: restoreRng(state.rng),
  };
  return reduce(state, action, ctx);
};

/**
 * Quantities a hostile client might send. The adversarial cases are named
 * explicitly rather than left to a wide `fc.integer` range: with `min: -100,
 * max: 5000` the generator draws a negative barely often enough to matter, and
 * a fuzz test that only theoretically reaches the interesting input is a fuzz
 * test that silently stops finding the bug.
 */
const quantity = (): fc.Arbitrary<number> =>
  fc.oneof(
    { arbitrary: fc.integer({ min: -1000, max: -1 }), weight: 2 },
    { arbitrary: fc.constantFrom(0, 1), weight: 1 },
    { arbitrary: fc.integer({ min: 1, max: 5000 }), weight: 3 },
  );

/** Every action a player can take, including nonsensical ones. */
const anyAction = (): fc.Arbitrary<Action> =>
  fc.oneof(
    fc.constant(tick(TICK_MS)),
    fc.constant(tick(TICK_MS * 10)),
    fc.constantFrom(...content.start.assemblyPieces.map((p) => p.id)).map((pieceId) => ({
      type: 'ATTACH_PIECE' as const,
      pieceId,
    })),
    fc
      .tuple(
        fc.constantFrom(...content.materials.map((m) => m.id)),
        fc.constantFrom(...content.objects.map((o) => o.id)),
      )
      .map(([materialId, objectId]) => setSlotConfig(FIRST_SLOT_ID, materialId, objectId)),
    fc.constant(startPrint(FIRST_SLOT_ID)),
    fc.oneof(fc.constant(sellParts(null)), quantity().map(sellParts)),
    fc
      .tuple(fc.constantFrom(...content.materials.map((m) => m.id)), quantity())
      .map(([materialId, grams]) => buyFilament(materialId, grams)),
    fc.constant(buyPrinter(printerId, FIRST_SLOT_ID)),
    fc
      .tuple(fc.constantFrom(...content.materials.map((m) => m.id)), quantity())
      .map(([materialId, grams]) => sellFilament(materialId, grams)),
    fc.constantFrom(...content.upgrades.map((u) => u.id)).map(buyUpgrade),
    fc.constantFrom(...content.automation.map((a) => a.id)).map(buyAutomation),
    fc
      .tuple(fc.constantFrom(...content.automation.map((a) => a.id)), quantity())
      .map(([automationId, threshold]) => setAutomation(automationId, { threshold })),
    fc
      .tuple(fc.constantFrom(...content.materials.map((m) => m.id)), quantity())
      .map(([materialId, grams]) => recycleScrap(materialId, grams)),
    fc.constantFrom(...content.materials.map((m) => m.id)).map((id) => recycleScrap(id, null)),
  );

const ticksFor = (designSeconds: number): number => (designSeconds * 1000) / TICK_MS;

/** Play the intro for real; random actions alone would never get through it. */
function assembled(seed: number): GameState {
  let state = createInitialState(content, { seed });
  for (const piece of content.start.assemblyPieces) {
    for (let i = 0; i < ticksFor(piece.attachDesignSeconds); i += 1) {
      state = apply(state, tick(TICK_MS));
    }
    state = apply(state, { type: 'ATTACH_PIECE', pieceId: piece.id });
  }
  return state;
}

/** A printing workshop that has reached `bench`, where buying is unlocked. */
function trading(seed: number): GameState {
  let state = apply(
    assembled(seed),
    setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID),
  );
  state = apply(state, startPrint(FIRST_SLOT_ID));
  for (let i = 0; i < ticksFor(60); i += 1) {
    state = apply(state, tick(TICK_MS));
  }
  state = apply(state, sellParts(null));
  state = apply(state, tick(TICK_MS));
  return state;
}

/** A workshop with the full rack staffed (spec §4's hard maximum). */
function fullRack(seed: number): GameState {
  const base = trading(seed);
  const capacity = hardSlotMaximum(content);
  return {
    ...base,
    printers: { [printerId]: capacity },
    slots: Array.from({ length: capacity }, (_unused, index) =>
      testSlot({
        id: `${content.start.slotIdPrefix}-${index + 1}`,
        materialId: FIRST_MATERIAL_ID,
        objectId: FIRST_OBJECT_ID,
        printerCount: 1,
      }),
    ),
  };
}

/**
 * Start states that actually unlock the actions under test. Fuzzing from a
 * fresh save alone is close to vacuous: the phase FSM gates every economy
 * action behind an intro that random input will never complete.
 */
const startStates = (): fc.Arbitrary<GameState> =>
  fc.constantFrom(createInitialState(content, { seed: 4 }), assembled(4), trading(4), fullRack(4));

describe('property: resources are never negative', () => {
  it('holds for arbitrary action sequences from any reachable state', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 120 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            state = apply(state, action);
            for (const [kind, amount] of Object.entries(state.resources)) {
              expect(amount, `${kind} went negative`).toBeGreaterThanOrEqual(0);
            }
            for (const [materialId, grams] of Object.entries(state.filamentGrams)) {
              expect(grams, `${materialId} filament went negative`).toBeGreaterThanOrEqual(0);
            }
            expect(state.partsValue).toBeGreaterThanOrEqual(0);
            expect(state.scrapValue).toBeGreaterThanOrEqual(0);
            for (const listing of Object.values(state.market)) {
              expect(listing.stockGrams).toBeGreaterThanOrEqual(0);
            }
            for (const owned of Object.values(state.printers)) {
              expect(owned).toBeGreaterThanOrEqual(0);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never lets a sale create value out of an empty inventory', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 10_000 }), (count) => {
        const state = createInitialState(content, { seed: 1 });
        const sold = apply(state, sellParts(count));
        expect(sold.resources.money).toBe(0);
        expect(sold.resources.parts).toBe(0);
      }),
      { numRuns: 40 },
    );
  });
});

describe('property: offline(2t) ≡ offline(t) ∘ offline(t)', () => {
  /** A save mid-print, so offline catch-up has an economy to advance. */
  const running = (): GameState => {
    let state = createInitialState(content, { seed: 11 });
    for (const piece of content.start.assemblyPieces) {
      for (let i = 0; i < (piece.attachDesignSeconds * 1000) / TICK_MS; i += 1) {
        state = apply(state, tick(TICK_MS));
      }
      state = apply(state, { type: 'ATTACH_PIECE', pieceId: piece.id });
    }
    state = apply(state, setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID));
    return apply(state, startPrint(FIRST_SLOT_ID));
  };

  const start = running();

  const offline = (state: GameState, wallElapsedMs: number, carrySimMs: number) =>
    runOfflineCatchUp({ state, content, wallElapsedMs, nowMs: 0, carrySimMs });

  it('splits a catch-up into two halves with an identical result', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), (minutes) => {
        const half = minutes * MS_PER_MINUTE;
        const once = offline(start, half * 2, 0);
        const first = offline(start, half, 0);
        const second = offline(first.state, half, first.carrySimMs);
        expect(second.state).toEqual(once.state);
        expect(second.carrySimMs).toBeCloseTo(once.carrySimMs, 9);
      }),
      { numRuns: 12 },
    );
  });

  it('matches playing the same time online, tick for tick', () => {
    const wallMs = MS_PER_MINUTE * 20;
    const summary = offline(start, wallMs, 0);
    let online = start;
    for (let i = 0; i < wallMs / TICK_MS; i += 1) {
      online = apply(online, tick(TICK_MS));
    }
    expect(summary.state).toEqual(online);
  });

  it('caps at pacing.offlineCapHours and reports the remainder as skipped', () => {
    const cap = content.pacing.offlineCapHours;
    const result = offline(start, MS_PER_HOUR * (cap * 2), 0);
    expect(result.summary.appliedWallMs).toBe(MS_PER_HOUR * cap);
    expect(result.summary.skippedWallMs).toBe(MS_PER_HOUR * cap);
    expect(result.summary.gains.partsProduced).toBeGreaterThan(0);
  });
});

/**
 * The M3 economy invariants (spec §13). Each of these is a rule that, if it
 * ever broke, would break quietly: an exploit the player finds long before the
 * developer does.
 */
const TRADED_MATERIAL_ID = 'petg';
const RECYCLER_ID = content.failure.recycler.requiresUpgradeId;

/** A workshop with money, an unlocked market and the machine tree it needs. */
function merchant(money: number): GameState {
  const base = trading(9);
  return {
    ...base,
    phaseId: 'bench',
    resources: { ...base.resources, money },
    upgrades: { 'heated-bed': 1, [RECYCLER_ID]: 1 },
  };
}

describe('property: a buy/sell round trip never creates value', () => {
  it('holds for any parcel size at any point in the price cycle', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 0, max: 240 }),
        (grams, minutes) => {
          const start: GameState = {
            ...merchant(1_000_000),
            simTimeMs: minutes * MS_PER_MINUTE,
          };
          const bought = apply(start, buyFilament(TRADED_MATERIAL_ID, grams));
          // A refused buy is not a round trip; skip it rather than pass vacuously.
          fc.pre(bought.filamentGrams[TRADED_MATERIAL_ID] === grams);
          const sold = apply(bought, sellFilament(TRADED_MATERIAL_ID, grams));
          expect(sold.filamentGrams[TRADED_MATERIAL_ID]).toBe(0);
          expect(sold.resources.money).toBeLessThanOrEqual(start.resources.money);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('holds when the round trip is split into many small sells', () => {
    const grams = 1200;
    const start = merchant(1_000_000);
    let state = apply(start, buyFilament(TRADED_MATERIAL_ID, grams));
    for (let i = 0; i < 12; i += 1) {
      state = apply(state, sellFilament(TRADED_MATERIAL_ID, grams / 12));
    }
    expect(state.resources.money).toBeLessThanOrEqual(start.resources.money);
  });

  /**
   * The guard that makes the property mean something: with the trade priced
   * *before* its own market impact instead of after, a large buy-then-sell
   * turns a profit. This asserts the loss is not merely the spread.
   */
  it('loses more than the spread alone, because the trade moves the price', () => {
    const grams = 4000;
    const start = merchant(1_000_000);
    const quoted = quoteFor(start, content, TRADED_MATERIAL_ID);
    const bought = apply(start, buyFilament(TRADED_MATERIAL_ID, grams));
    const sold = apply(bought, sellFilament(TRADED_MATERIAL_ID, grams));
    const loss = start.resources.money - sold.resources.money;
    const spreadOnly = (quoted?.buyPerGram ?? 0) * grams * content.market.model.spread;
    expect(loss).toBeGreaterThan(spreadOnly);
  });
});

describe('property: the recycler conserves value', () => {
  it('never hands back filament worth more than the scrap it consumed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.double({ min: 0.01, max: 500, noNaN: true }),
        fc.constantFrom(...content.materials.map((material) => material.id)),
        (scrapGrams, scrapValue, materialId) => {
          const base = merchant(0);
          const start: GameState = {
            ...base,
            resources: { ...base.resources, scrap: scrapGrams },
            scrapValue,
          };
          const after = apply(start, recycleScrap(materialId, null));
          const material = content.materials.find((candidate) => candidate.id === materialId);
          if (material === undefined || after === start) {
            return;
          }
          const gained =
            (after.filamentGrams[materialId] ?? 0) - (start.filamentGrams[materialId] ?? 0);
          const outputValue = gained * material.costPerGram;
          expect(outputValue).toBeLessThanOrEqual(scrapValue + 1e-9);
          // The banked value leaves with the scrap: nothing is stranded either.
          expect(after.scrapValue).toBeLessThanOrEqual(start.scrapValue + 1e-9);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('cannot be run at all without the machine node', () => {
    const base = trading(9);
    const start: GameState = {
      ...base,
      phaseId: 'bench',
      resources: { ...base.resources, scrap: 500 },
      scrapValue: 50,
    };
    expect(apply(start, recycleScrap(FIRST_MATERIAL_ID, null))).toBe(start);
  });
});

describe('property: market prices stay within their configured bounds', () => {
  const model = content.market.model;

  it('holds for any material, time and pressure', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...content.market.listings.map((listing) => listing.materialId)),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        (materialId, minutes, pressure, seed) => {
          const multiplier = priceMultiplier(model, materialId, minutes, pressure, seed);
          expect(multiplier).toBeGreaterThanOrEqual(model.minPriceMultiplier);
          expect(multiplier).toBeLessThanOrEqual(model.maxPriceMultiplier);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds through arbitrary play, quotes included', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 80 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            state = apply(state, action);
          }
          for (const listing of content.market.listings) {
            const quote = quoteFor(state, content, listing.materialId);
            expect(quote?.multiplier).toBeGreaterThanOrEqual(model.minPriceMultiplier);
            expect(quote?.multiplier).toBeLessThanOrEqual(model.maxPriceMultiplier);
            expect(quote?.sellPerGram).toBeLessThanOrEqual(quote?.buyPerGram ?? 0);
            expect(marketStateOf(state, listing.materialId).stockGrams).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('property: pity failure is deterministic', () => {
  /**
   * Spec §7.1 asks for a pity timer rather than raw RNG precisely so that
   * failure is reproducible. Two runs from the same state must fail the same
   * prints, and — because the model draws nothing from the stream — the seed
   * must make no difference to *when* a print fails at all.
   */
  const printForSeconds = (seed: number, seconds: number): GameState => {
    let state = trading(seed);
    for (let i = 0; i < ticksFor(seconds); i += 1) {
      state = apply(state, tick(TICK_MS));
    }
    return state;
  };

  it('fails the same prints twice from the same state', () => {
    fc.assert(
      fc.property(fc.integer({ min: 30, max: 600 }), (seconds) => {
        const once = printForSeconds(5, seconds);
        const twice = printForSeconds(5, seconds);
        expect(twice.stats.printsFailed).toBe(once.stats.printsFailed);
        expect(twice.resources.scrap).toBe(once.resources.scrap);
        expect(twice.slots[0]?.failureCharge).toBe(once.slots[0]?.failureCharge);
      }),
      { numRuns: 10 },
    );
  });

  it('reaches the same charge under any seed — no dice are rolled', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (seed) => {
        const seeded = printForSeconds(seed, 300);
        const reference = printForSeconds(1, 300);
        expect(seeded.stats.printsFailed).toBe(reference.stats.printsFailed);
        expect(seeded.slots[0]?.failureCharge).toBeCloseTo(
          reference.slots[0]?.failureCharge ?? 0,
          9,
        );
      }),
      { numRuns: 15 },
    );
  });

  it('fails at exactly the rate the content asks for', () => {
    const perPrint = content.materials[0]?.failureChargePerPrint ?? 0;
    const threshold = content.failure.model.chargeThreshold;
    fc.assert(
      fc.property(fc.integer({ min: 120, max: 1200 }), (seconds) => {
        const state = printForSeconds(5, seconds);
        const attempted = state.stats.printsCompleted + state.stats.printsFailed;
        const expected = (attempted * perPrint) / threshold;
        // Within one print: the charge is a running float sum, so a batch that
        // lands exactly on the threshold may tip either side of it.
        expect(state.stats.printsFailed).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
        expect(state.stats.printsFailed).toBeLessThanOrEqual(Math.ceil(expected));
      }),
      { numRuns: 15 },
    );
  });
});

describe('property: pace invariance', () => {
  /**
   * Spec §13: the phase order and unlock sequence must be identical for any
   * `targetHours`. Only the wall-clock cost of getting there may change, which
   * is exactly what makes `targetHours` a length knob and not a balance knob.
   */
  const playToPhases = (targetHours: number, designMinutes: number): readonly string[] => {
    const paced = contentAt(targetHours);
    let state = createInitialState(paced, { seed: 3 });
    const seen: string[] = [state.phaseId];
    const step = (action: Action): void => {
      state = reduce(state, action, {
        content: paced,
        nowMs: state.simTimeMs,
        rng: restoreRng(state.rng),
      });
      if (seen.at(-1) !== state.phaseId) {
        seen.push(state.phaseId);
      }
    };
    for (const piece of paced.start.assemblyPieces) {
      for (let i = 0; i < (piece.attachDesignSeconds * 1000) / TICK_MS; i += 1) {
        step(tick(TICK_MS));
      }
      step({ type: 'ATTACH_PIECE', pieceId: piece.id });
    }
    step(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID));
    step(startPrint(FIRST_SLOT_ID));
    const ticks = (designMinutes * MS_PER_MINUTE) / TICK_MS;
    for (let i = 0; i < ticks; i += 1) {
      step(tick(TICK_MS));
      if (state.resources.parts > 0) {
        step(sellParts(null));
      }
    }
    return seen;
  };

  it('reaches the same phases in the same order at 4, 8 and 16 target hours', () => {
    const reference = playToPhases(8, 20);
    expect(reference.length).toBeGreaterThan(1);
    for (const targetHours of [4, 16]) {
      expect(playToPhases(targetHours, 20), `targetHours=${targetHours}`).toEqual(reference);
    }
  });

  it('changes only the wall-clock cost, never the design-time cost', () => {
    fc.assert(
      fc.property(fc.constantFrom(1, 2, 4, 8, 16, 32), (targetHours) => {
        const paced = contentAt(targetHours);
        // Design time is what content is authored in, so it must not move.
        expect(paced.start.assemblyPieces).toEqual(content.start.assemblyPieces);
        expect(paced.pacing.phases.map((p) => p.budgetDesignMinutes)).toEqual(
          content.pacing.phases.map((p) => p.budgetDesignMinutes),
        );
      }),
      { numRuns: 6 },
    );
  });
});

describe('property: saves round-trip exactly', () => {
  it('restores any reachable state unchanged', () => {
    fc.assert(
      fc.property(
        fc.array(anyAction(), { minLength: 0, maxLength: 80 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (actions, savedAtMs) => {
          let state = createInitialState(content, { seed: 9 });
          for (const action of actions) {
            state = apply(state, action);
          }
          expect(deserializeSave(serializeSave(state, savedAtMs))).toEqual(state);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('a reloaded save continues identically to one that was never saved', () => {
    let state = createInitialState(content, { seed: 5 });
    for (const piece of content.start.assemblyPieces) {
      for (let i = 0; i < (piece.attachDesignSeconds * 1000) / TICK_MS; i += 1) {
        state = apply(state, tick(TICK_MS));
      }
      state = apply(state, { type: 'ATTACH_PIECE', pieceId: piece.id });
    }
    state = apply(state, setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID));
    state = apply(state, startPrint(FIRST_SLOT_ID));

    const reloaded = deserializeSave(serializeSave(state, 0));
    let a = state;
    let b = reloaded;
    for (let i = 0; i < 600; i += 1) {
      a = apply(a, tick(TICK_MS));
      b = apply(b, tick(TICK_MS));
    }
    expect(b).toEqual(a);
  });
});

/**
 * The projection is the contract every renderer reads (spec §15), and the
 * renderer has no way to defend itself: a `progress` of 1.4 or a slot the
 * schema does not describe becomes a broken picture, not an exception. So the
 * guarantee has to hold for *any* reachable state, not just the fixtures.
 */
describe('property: the VisualState projection is always valid', () => {
  it('emits a schema-valid document from any reachable state', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 0, maxLength: 60 }),
        (start, actions) => {
          let state = start;
          for (const action of actions) {
            state = apply(state, action);
          }
          const visual = toVisualState(state, content);
          const validation = validateVisualState(visual);
          expect(validation.issues).toEqual([]);
          expect(validation.ok).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('projects exactly one entry per slot, never more, never fewer', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 0, maxLength: 40 }),
        (start, actions) => {
          let state = start;
          for (const action of actions) {
            state = apply(state, action);
          }
          const visual = toVisualState(state, content);
          expect(visual.slots).toHaveLength(state.slots.length);
          expect(visual.slots.map((slot) => slot.slotId)).toEqual(
            state.slots.map((slot) => slot.id),
          );
          expect(visual.slotCapacity).toBeGreaterThanOrEqual(visual.slots.length);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('keeps every fraction it publishes inside 0..1', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 0, maxLength: 60 }),
        (start, actions) => {
          let state = start;
          for (const action of actions) {
            state = apply(state, action);
          }
          const visual = toVisualState(state, content);
          for (const slot of visual.slots) {
            expect(slot.progress).toBeGreaterThanOrEqual(0);
            expect(slot.progress).toBeLessThanOrEqual(1);
            expect(slot.phaseOffset).toBeGreaterThanOrEqual(0);
            expect(slot.phaseOffset).toBeLessThan(1);
          }
          expect(visual.assembly.progress).toBeGreaterThanOrEqual(0);
          expect(visual.assembly.progress).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 40 },
    );
  });
});
