import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { loadContent } from '../content/load.js';
import { RAW_CONTENT } from '../content/raw.js';
import type { RawContent } from '../content/schema.js';
import { MS_PER_HOUR, MS_PER_MINUTE, TICK_MS } from '../engine/constants.js';
import { runOfflineCatchUp } from '../engine/offline.js';
import { restoreRng } from '../rng/mulberry32.js';
import { deserializeSave, serializeSave } from '../save/serialize.js';
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
import { buyFilament, buyPrinter, sellParts, setSlotConfig, startPrint, tick } from './actions.js';
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

/**
 * A workshop with the full rack staffed. `start.slotCount` is 1 until M4, so no
 * amount of play reaches this shape yet — but the projection has to be right
 * for it before the mechanic lands, not after.
 */
function fullRack(seed: number): GameState {
  const base = trading(seed);
  const capacity = content.start.maxSlotCount;
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
