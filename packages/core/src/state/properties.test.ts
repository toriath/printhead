import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { RawContent } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_HOUR, MS_PER_MINUTE, TICK_MS } from '../engine/constants.js';
import { runOfflineCatchUp } from '../engine/offline.js';
import { restoreRng } from '../rng/mulberry32.js';
import { deserializeSave, serializeSave } from '../save/serialize.js';
import { assignedPrinters, printersPerSlot } from '../systems/fleet.js';
import { marketStateOf, priceMultiplier, quoteFor } from '../systems/market.js';
import { moneyPrintRate } from '../systems/prestige.js';
import { countPrinters } from '../systems/requirements.js';
import { effectiveSlotCapacity, hardSlotMaximum } from '../systems/slots.js';
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
  assignPrinter,
  buyAutomation,
  buyFilament,
  buyMoneyPrinter,
  buyPrinter,
  buySlot,
  buyUpgrade,
  chooseFork,
  createDesign,
  prestige,
  recycleScrap,
  sellFilament,
  sellParts,
  sellProducts,
  setAutomation,
  setSlotConfig,
  setSlotDesign,
  setSlotQueue,
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
    // --- M4: slots, fleet, rotas and the fork (spec §4, §5B) ---
    fc
      .constantFrom(...content.slots.map((s) => s.id))
      .map(buySlot),
    fc.constantFrom(...content.forks.map((f) => f.id)).map(chooseFork),
    fc
      .tuple(slotIds(), slotIds(), quantity())
      .map(([from, to, count]) => assignPrinter(from, to, count)),
    fc
      .tuple(
        slotIds(),
        fc.array(
          fc
            .tuple(
              fc.constantFrom(...content.materials.map((m) => m.id)),
              fc.constantFrom(...content.objects.map((o) => o.id)),
              fc.integer({ min: 1, max: 5 }),
            )
            .map(([materialId, objectId, batches]) => ({ materialId, objectId, batches })),
          { maxLength: 3 },
        ),
      )
      .map(([slotId, entries]) => setSlotQueue(slotId, entries)),
    // --- M5: the studio, the melt-down and the presses (spec §5D, §5E) ---
    fc
      .constantFrom(...content.designs.map((d) => d.id))
      .map(createDesign),
    fc
      .tuple(slotIds(), fc.constantFrom(...content.designs.map((d) => d.id)))
      .map(([slotId, designId]) => setSlotDesign(slotId, designId)),
    fc.oneof(fc.constant(sellProducts(null)), quantity().map(sellProducts)),
    fc.constant(prestige()),
    fc.constantFrom(...content.prestige.moneyPrinters.map((def) => def.id)).map(buyMoneyPrinter),
  );

/**
 * Bay ids, weighted towards the two a workshop actually owns.
 *
 * Spreading uniformly over four ids plus a ghost sounds more adversarial and is
 * strictly worse: `ASSIGN_PRINTER` then needs a 1-in-25 pair to land on two
 * real bays, and the fleet-conservation property below silently never fires a
 * single successful move. The ghost id is still drawn — it is how the
 * `unknown-target` path gets covered — just not most of the time.
 */
const slotIds = (): fc.Arbitrary<string> =>
  fc.oneof(
    { arbitrary: fc.constantFrom(`${content.start.slotIdPrefix}-1`), weight: 4 },
    { arbitrary: fc.constantFrom(`${content.start.slotIdPrefix}-2`), weight: 4 },
    {
      arbitrary: fc.constantFrom(
        ...Array.from(
          { length: hardSlotMaximum(content) },
          (_unused, index) => `${content.start.slotIdPrefix}-${index + 1}`,
        ),
        'ghost-slot',
      ),
      weight: 2,
    },
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
 * A farm-phase workshop with a full first bay and money in the tin. Everything
 * M4 adds — buying a bay, moving machines, writing a rota — is gated on this
 * phase, so without it the fleet properties below would fuzz a game in which
 * none of their actions are even legal.
 */
function scaled(seed: number): GameState {
  const base = trading(seed);
  const rota = content.automation.find((def) => def.behavior === 'auto-changeover');
  const ceiling = content.start.printersPerSlot;
  return {
    ...base,
    phaseId: 'farm',
    resources: { ...base.resources, parts: 3000 },
    partsValue: 3000,
    printers: { [printerId]: ceiling },
    slots: [
      testSlot({
        id: FIRST_SLOT_ID,
        materialId: FIRST_MATERIAL_ID,
        objectId: FIRST_OBJECT_ID,
        printerCount: ceiling,
      }),
    ],
    automation:
      rota === undefined
        ? base.automation
        : {
            ...base.automation,
            [rota.id]: { level: 1, enabled: true, threshold: rota.defaultThreshold, cooldownMs: 0 },
          },
  };
}

/** The same workshop with the second bay already bought and half-staffed. */
function racked(seed: number): GameState {
  const base = scaled(seed);
  const ceiling = content.start.printersPerSlot;
  return {
    ...base,
    slots: [
      testSlot({
        id: `${content.start.slotIdPrefix}-1`,
        materialId: FIRST_MATERIAL_ID,
        objectId: FIRST_OBJECT_ID,
        printerCount: ceiling,
      }),
      testSlot({
        id: `${content.start.slotIdPrefix}-2`,
        materialId: FIRST_MATERIAL_ID,
        objectId: FIRST_OBJECT_ID,
        printerCount: 1,
      }),
    ],
    printers: { [printerId]: ceiling + 1 },
  };
}

/** The same workshop one phase on, where the Farm/Goliath fork is affordable. */
function forking(seed: number): GameState {
  const base = racked(seed);
  return {
    ...base,
    phaseId: 'studio',
    // The enclosure is the third bay's prerequisite, so this workshop can buy
    // one — without it the only state that could reach `BUY_SLOT` at all would
    // be `scaled`, and the coverage check below would depend on the draw.
    upgrades: { ...base.upgrades, enclosure: 1 },
    resources: { ...base.resources, parts: 9000 },
    partsValue: 9000,
  };
}

/**
 * A studio-phase workshop with resin open and Money in the bank: the state in
 * which drafting a Design is a legal move at all (spec §5D). Without it every
 * M5 action below would be rejected on the material gate and the properties
 * would pass by never happening.
 */
function studioReady(seed: number): GameState {
  const base = forking(seed);
  return {
    ...base,
    // The machine tree, not a flag: `isMaterialAvailable` reads these nodes.
    upgrades: { ...base.upgrades, 'heated-bed': 1, enclosure: 1, 'sla-unit': 1, 'design-desk': 2 },
    resources: { ...base.resources, money: 5_000_000 },
    filamentGrams: { ...base.filamentGrams, resin: 5000 },
  };
}

/** The same workshop with the capstone drafted, so the melt-down is on offer. */
function melting(seed: number): GameState {
  const base = studioReady(seed);
  const capstone = content.prestige.requiredDesignId;
  const other = content.designs.find((def) => def.id !== capstone)?.id ?? capstone;
  return {
    ...base,
    phaseId: content.prestige.unlockPhaseId,
    designs: {
      [capstone]: { level: 3, printsOnLevel: 1 },
      [other]: { level: 1, printsOnLevel: 0 },
    },
    resources: { ...base.resources, designs: 2, products: 12, plates: 4 },
    productsValue: 900,
    moneyPrinters: { [content.prestige.moneyPrinters[0]?.id ?? 'bill-printer']: 1 },
  };
}

/**
 * Start states that actually unlock the actions under test. Fuzzing from a
 * fresh save alone is close to vacuous: the phase FSM gates every economy
 * action behind an intro that random input will never complete.
 */
const startStates = (): fc.Arbitrary<GameState> =>
  fc.constantFrom(
    createInitialState(content, { seed: 4 }),
    assembled(4),
    trading(4),
    fullRack(4),
    scaled(4),
    racked(4),
    forking(4),
    studioReady(4),
    melting(4),
  );

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

  /**
   * A melted-down workshop, mid-rebuild, with a commission on the bench and the
   * presses running. M5 put three new things inside the tick — the studio
   * clock, the money printers and the self-assembling intro — and every one of
   * them is exactly the sort of accumulator that quietly disagrees with itself
   * when the tick stream is chunked. Fuzzing the bench loop alone would never
   * touch any of them.
   */
  const rebuilding = (): GameState => {
    const melted = apply(melting(3), prestige());
    return {
      ...melted,
      studio: { designId: content.designs[0]?.id ?? '', remainingMs: 8 * MS_PER_MINUTE },
    };
  };

  const offline = (state: GameState, wallElapsedMs: number, carrySimMs: number) =>
    runOfflineCatchUp({ state, content, wallElapsedMs, nowMs: 0, carrySimMs });

  it('splits a catch-up into two halves with an identical result', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(start, rebuilding()),
        fc.integer({ min: 0, max: 30 }),
        (from, minutes) => {
          const half = minutes * MS_PER_MINUTE;
          const once = offline(from, half * 2, 0);
          const first = offline(from, half, 0);
          const second = offline(first.state, half, first.carrySimMs);
          expect(second.state).toEqual(once.state);
          expect(second.carrySimMs).toBeCloseTo(once.carrySimMs, 9);
        },
      ),
      { numRuns: 16 },
    );
  });

  it('matches playing the same time online, tick for tick', () => {
    const wallMs = MS_PER_MINUTE * 20;
    for (const from of [start, rebuilding()]) {
      const summary = offline(from, wallMs, 0);
      let online = from;
      for (let i = 0; i < wallMs / TICK_MS; i += 1) {
        online = apply(online, tick(TICK_MS));
      }
      expect(summary.state).toEqual(online);
    }
  });

  it('rebuilds the workshop and runs the presses while the player is away', () => {
    const away = offline(rebuilding(), MS_PER_MINUTE * 30, 0).state;
    expect(away.assembly.attachedPieceIds.length).toBe(content.start.assemblyPieces.length);
    expect(away.designs[content.designs[0]?.id ?? '']).toBeDefined();
    expect(away.stats.moneyPrinted).toBeGreaterThan(0);
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

  it('projects exactly one entry per *active* slot, never more, never fewer', () => {
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
          // A Goliath run melts the rack into one bay (spec §5B), so the bays
          // the projection publishes are the *active* ones, not every row the
          // save happens to still carry.
          const active = effectiveSlotCapacity(state, content);
          expect(visual.slots).toHaveLength(active);
          expect(visual.slots.map((slot) => slot.slotId)).toEqual(
            state.slots.slice(0, active).map((slot) => slot.id),
          );
          expect(visual.slotCapacity).toBeGreaterThanOrEqual(visual.slots.length);
          expect(visual.fleet.assigned).toBe(visual.fleet.printers);
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

/**
 * Fleet allocation is bookkeeping, and bookkeeping that leaks is a duplication
 * glitch. Whatever a player does with the rack, the machines standing in bays
 * must be exactly the machines they own — no more (free printers) and no fewer
 * (machines lost in a move). This is the property that would have caught a
 * `ASSIGN_PRINTER` that credited the target before debiting the source.
 */
describe('property: printer assignment conserves the fleet (spec §4)', () => {
  it('keeps Σ slot.printerCount equal to the printers owned', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 120 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            state = apply(state, action);
            expect(assignedPrinters(state), 'a machine went missing or was duplicated').toBe(
              countPrinters(state),
            );
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never overfills a bay past the ceiling the content declares', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 120 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            state = apply(state, action);
            const ceiling = printersPerSlot(state, content);
            for (const slot of state.slots) {
              expect(slot.printerCount, `${slot.id} overfilled`).toBeLessThanOrEqual(ceiling);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * Spec §4: slots go **1 → 2 → 3 → 4 (hard max)**. The cap is derived from the
 * unlock list, so this property is really "no sequence of clicks can grow the
 * rack past the bays content declares" — including the prestige-gated fourth,
 * which nothing in M4 can open.
 */
describe('property: the slot cap is never exceeded (spec §4)', () => {
  it('holds for arbitrary play, and the active rack never exceeds the owned one', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 120 }),
        (from, actions) => {
          let state = from;
          const cap = hardSlotMaximum(content);
          for (const action of actions) {
            state = apply(state, action);
            expect(state.slots.length).toBeLessThanOrEqual(cap);
            expect(effectiveSlotCapacity(state, content)).toBeLessThanOrEqual(state.slots.length);
            // Bay ids stay unique — a duplicate would make `slotIndexOf` lie.
            expect(new Set(state.slots.map((slot) => slot.id)).size).toBe(state.slots.length);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * Spec §5B: the Farm/Goliath fork is **mutually exclusive per run**. Once a
 * branch is committed, no sequence of actions may replace it — the run's shape
 * is decided, and the endgame depends on which one it was.
 *
 * "Per run" became load-bearing at M5: a melt-down *is* the end of the run
 * (spec §5D), and the next one is entitled to choose the other branch. So the
 * invariant is stated as a transition rule — null → branch when it is chosen,
 * branch → null when the workshop is melted down, and never branch → branch.
 */
describe('property: the Farm/Goliath fork is exclusive (spec §5B)', () => {
  it('never swaps one branch for another; only a melt-down clears it', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 150 }),
        (from, actions) => {
          // Start committed to a branch chosen at random, so both are covered.
          const forkId = content.forks[from.simTimeMs % content.forks.length]?.id ?? null;
          let state: GameState = { ...from, forkId };
          for (const action of actions) {
            const before = state.forkId;
            state = apply(state, action);
            if (state.forkId === before) {
              continue;
            }
            if (state.forkId === null) {
              expect(action.type, 'a fork was cleared by something other than a melt-down').toBe(
                'PRESTIGE',
              );
              continue;
            }
            expect(before, 'a committed fork was overwritten').toBeNull();
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reaches at most one branch per run', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 150 }),
        (from, actions) => {
          let state = from;
          let chosen = new Set<string>();
          for (const action of actions) {
            const before = state;
            state = apply(state, action);
            if (action.type === 'PRESTIGE' && state !== before) {
              // A new run: the previous commitment is history, not a conflict.
              chosen = new Set<string>();
            }
            if (state.forkId !== null) {
              chosen.add(state.forkId);
            }
            expect(chosen.size).toBeLessThanOrEqual(1);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * A property that never exercises its mechanic is decoration.
 *
 * The M4 invariants above are all "nothing bad happened" shapes, which pass
 * trivially on a game where `BUY_SLOT` and `CHOOSE_FORK` are phase-gated into
 * no-ops — exactly what would happen if the start states drifted back to the
 * intro. This test asserts the fuzz really reaches each mechanic, so those
 * properties stay load-bearing rather than quietly becoming vacuous.
 */
describe('the M4 properties are not vacuous', () => {
  it('the generated play actually buys bays, moves machines and takes the fork', () => {
    // Counted by *action type* rather than by guessing from a state diff: a
    // consolidating fork also moves machines, and crediting that to
    // ASSIGN_PRINTER is exactly how a vacuity check quietly lies.
    const reached: Record<string, boolean> = {
      BUY_SLOT: false,
      ASSIGN_PRINTER: false,
      SET_SLOT_QUEUE: false,
      CHOOSE_FORK: false,
    };
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 40, maxLength: 200 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            const before = state;
            state = apply(state, action);
            if (state !== before && action.type in reached) {
              reached[action.type] = true;
            }
          }
        },
      ),
      // A fixed seed: this test asserts *coverage*, and a coverage claim that
      // depends on today's dice is not a claim at all.
      { numRuns: 80, seed: 20260812 },
    );
    expect(reached).toEqual({
      BUY_SLOT: true,
      ASSIGN_PRINTER: true,
      SET_SLOT_QUEUE: true,
      CHOOSE_FORK: true,
    });
  });
});

/**
 * Spec §2, §5D, §13: **prestige preserves Designs exactly.**
 *
 * Not "roughly", not "at level 1", not "the ids": the same ledger, level and
 * per-level progress. Designs are the game's only permanent progression, so a
 * melt-down that rounded a level down would quietly erase hours of play, and
 * the mistake would be invisible until somebody compared two saves.
 */
describe('property: the melt-down preserves Designs exactly (spec §13)', () => {
  it('carries the whole ledger across, whatever the run looked like', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 150 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            const before = state.designs;
            state = apply(state, action);
            if (action.type !== 'PRESTIGE' || state.stats.prestigeCount === 0) {
              continue;
            }
            // A melt-down really happened: the ledger must be untouched.
            expect(state.designs, 'a melt-down altered the Designs').toEqual(before);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('never loses a Design once drafted, however the run is played', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 150 }),
        (from, actions) => {
          let state = from;
          const seen = new Map<string, number>();
          for (const action of actions) {
            state = apply(state, action);
            for (const [designId, design] of Object.entries(state.designs)) {
              const best = seen.get(designId) ?? 0;
              // Levels only ever go up, and an owned Design is owned forever.
              expect(design.level, `${designId} regressed`).toBeGreaterThanOrEqual(best);
              seen.set(designId, design.level);
            }
            for (const designId of seen.keys()) {
              expect(state.designs[designId], `${designId} vanished`).toBeDefined();
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

/**
 * Spec §13: **money printing is monotone in Plates.** More Plates can never
 * print less money. The rate is `rateCurve(plates) × level` summed over the
 * installed presses, so this really tests that nothing in the fold divides by
 * the Plate count or subtracts a "diminishing returns" term — the shape of the
 * reward has to live in the curve, where content can see it.
 */
describe('property: money printing is monotone in Plates (spec §13)', () => {
  const curves = createCurveRegistry(content.curves);

  it('never pays less for more Plates, at any install level', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5 }),
        (a, b, level) => {
          const base = melting(1);
          const press = content.prestige.moneyPrinters[0];
          if (press === undefined) {
            return;
          }
          const at = (plates: number): number =>
            moneyPrintRate(
              {
                ...base,
                resources: { ...base.resources, plates },
                moneyPrinters: { [press.id]: level },
              },
              content,
              curves,
            );
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(at(high)).toBeGreaterThanOrEqual(at(low));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('prints nothing without Plates, however many presses are installed', () => {
    const base = melting(1);
    const press = content.prestige.moneyPrinters[0];
    expect(press).toBeDefined();
    expect(
      moneyPrintRate(
        {
          ...base,
          resources: { ...base.resources, plates: 0 },
          moneyPrinters: { [press?.id ?? '']: 5 },
        },
        content,
        curves,
      ),
    ).toBe(0);
  });

  it('the money the presses actually print rises with the Plates held', () => {
    const base = melting(1);
    const press = content.prestige.moneyPrinters[0];
    const minted = (plates: number): number => {
      let state: GameState = {
        ...base,
        resources: { ...base.resources, plates, money: 0 },
        moneyPrinters: { [press?.id ?? '']: 1 },
        stats: { ...base.stats, moneyPrinted: 0 },
      };
      for (let i = 0; i < 100; i += 1) {
        state = apply(state, tick(TICK_MS));
      }
      return state.stats.moneyPrinted;
    };
    expect(minted(10)).toBeGreaterThan(minted(1));
    expect(minted(1)).toBeGreaterThan(minted(0));
  });
});

/**
 * Spec §5D: the melt-down **scraps the run**. Everything the content does not
 * name as retained has to come back at (or below) what a brand-new workshop
 * starts with — otherwise "prestige" is a free top-up and the whole decision
 * evaporates.
 */
describe('property: the melt-down never increases a non-persistent resource', () => {
  const fresh = createInitialState(content, { seed: 1 });
  const retained = new Set<string>(content.prestige.retainedResources);

  it('resets every balance the content does not retain', () => {
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 1, maxLength: 150 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            const before = state;
            state = apply(state, action);
            if (action.type !== 'PRESTIGE' || state === before) {
              continue;
            }
            for (const [kind, amount] of Object.entries(state.resources)) {
              if (retained.has(kind)) {
                continue;
              }
              expect(amount, `${kind} survived the melt-down`).toBeLessThanOrEqual(
                fresh.resources[kind as keyof typeof fresh.resources],
              );
            }
            // The workshop itself is gone too, not just the balances.
            expect(state.printers).toEqual({});
            expect(state.upgrades).toEqual({});
            expect(state.automation).toEqual({});
            expect(state.forkId).toBeNull();
            expect(state.productsValue).toBe(0);
            expect(state.partsValue).toBe(0);
            expect(state.slots).toHaveLength(content.start.slotCount);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('keeps the Plate-bought presses, because content says to (spec §5E)', () => {
    const before = melting(1);
    const after = apply(before, prestige());
    expect(after.stats.prestigeCount).toBe(before.stats.prestigeCount + 1);
    expect(after.moneyPrinters).toEqual(before.moneyPrinters);
    expect(after.selfAssembling).toBe(true);
    // Re-point the content at nothing but the Designs and the presses go with
    // the rest of the run — the rule is data, not a special case in the code.
    const designsOnly = {
      ...content,
      prestige: { ...content.prestige, retainedLedgers: ['designs' as const] },
    };
    const stripped = reduce(before, prestige(), {
      content: designsOnly,
      nowMs: before.simTimeMs,
      rng: restoreRng(before.rng),
    });
    expect(stripped.moneyPrinters).toEqual({});
    expect(stripped.designs).toEqual(before.designs);
  });
});

/**
 * The same vacuity guard the M4 properties carry: an invariant that never sees
 * its mechanic is decoration. Every M5 action has to be genuinely reached by
 * the generated play, or the three properties above prove nothing.
 */
describe('the M5 properties are not vacuous', () => {
  it('the generated play drafts, loads, sells, melts down and buys a press', () => {
    const reached: Record<string, boolean> = {
      CREATE_DESIGN: false,
      SET_SLOT_DESIGN: false,
      SELL_PRODUCTS: false,
      PRESTIGE: false,
      BUY_MONEY_PRINTER: false,
    };
    fc.assert(
      fc.property(
        startStates(),
        fc.array(anyAction(), { minLength: 40, maxLength: 200 }),
        (from, actions) => {
          let state = from;
          for (const action of actions) {
            const before = state;
            state = apply(state, action);
            if (state !== before && action.type in reached) {
              reached[action.type] = true;
            }
          }
        },
      ),
      // Fixed seed, for the same reason the M4 check fixes one.
      { numRuns: 80, seed: 20260813 },
    );
    expect(reached).toEqual({
      CREATE_DESIGN: true,
      SET_SLOT_DESIGN: true,
      SELL_PRODUCTS: true,
      PRESTIGE: true,
      BUY_MONEY_PRINTER: true,
    });
  });
});
