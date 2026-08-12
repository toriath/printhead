import { describe, expect, it } from 'vitest';
import type { Content, MaterialDef } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { collectEvents } from '../events/bus.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, createInitialState } from '../state/game-state.js';
import { applyChangeover, resolveSlotConfig, tickSlots } from './printing.js';

/**
 * Changeover (spec §3): switching a slot's material costs downtime and purges
 * the outgoing spool. The rule that matters for the engine is that neither the
 * purge nor its aftermath may lose a tick — `offline(2t) ≡ offline(t)²` depends
 * on every millisecond going somewhere.
 */
const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 1 });
const petg = content.materials.find((material) => material.id === 'petg') as MaterialDef;
const OBJECT_ID = 'bracket';

const loaded = (materialId: string | null, over: Partial<GameState> = {}): GameState => ({
  ...base,
  printers: { 'bench-mk1': 1 },
  filamentGrams: { pla: 500, petg: 500 },
  slots: [testSlot({ materialId, objectId: OBJECT_ID, printerCount: 1 })],
  ...over,
});

const configFor = (materialId: string) => {
  const config = resolveSlotConfig(content, testSlot({ materialId, objectId: OBJECT_ID }));
  if (config === null) {
    throw new Error(`unresolvable config: ${materialId}`);
  }
  return config;
};

describe('applyChangeover', () => {
  it('is free when the slot was empty — nothing to purge', () => {
    const state = loaded(null);
    const slot = state.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const { state: after, changeover } = applyChangeover(state, slot, configFor('pla'));
    expect(changeover.downtimeMs).toBe(0);
    expect(changeover.purgedGrams).toBe(0);
    expect(after.filamentGrams.pla).toBe(500);
    expect(changeover.slot.materialId).toBe('pla');
  });

  it('is free when only the object changes — the nozzle never moves', () => {
    const state = loaded('pla');
    const slot = state.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const gearset = resolveSlotConfig(
      content,
      testSlot({ materialId: 'pla', objectId: 'gearset' }),
    );
    if (gearset === null) {
      throw new Error('expected gearset to resolve');
    }
    const { changeover } = applyChangeover(state, slot, gearset);
    expect(changeover.downtimeMs).toBe(0);
    expect(changeover.slot.objectId).toBe('gearset');
  });

  it('charges the incoming material downtime and purges the outgoing spool', () => {
    const state = loaded('pla');
    const slot = state.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const { state: after, changeover } = applyChangeover(state, slot, configFor('petg'));
    expect(changeover.downtimeMs).toBe(petg.changeoverDesignSeconds * MS_PER_SECOND);
    expect(changeover.purgedGrams).toBe(petg.changeoverWasteGrams);
    expect(changeover.purgedMaterialId).toBe('pla');
    expect(after.filamentGrams.pla).toBe(500 - petg.changeoverWasteGrams);
    expect(changeover.slot.changeoverMs).toBe(changeover.downtimeMs);
  });

  it('purges only what is actually on the spool', () => {
    const state = loaded('pla', { filamentGrams: { pla: 3, petg: 0 } });
    const slot = state.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    const { state: after, changeover } = applyChangeover(state, slot, configFor('petg'));
    expect(changeover.purgedGrams).toBe(3);
    expect(after.filamentGrams.pla).toBe(0);
  });

  it('resets the pity timer: the charge belonged to the old material', () => {
    const state = loaded('pla', {
      slots: [
        testSlot({ materialId: 'pla', objectId: OBJECT_ID, printerCount: 1, failureCharge: 0.9 }),
      ],
    });
    const slot = state.slots[0];
    if (slot === undefined) {
      throw new Error('expected a slot');
    }
    expect(applyChangeover(state, slot, configFor('petg')).changeover.slot.failureCharge).toBe(0);
  });
});

describe('a slot in changeover', () => {
  const purging = (changeoverMs: number, over: Partial<GameState> = {}): GameState =>
    loaded('pla', {
      slots: [
        testSlot({
          materialId: 'pla',
          objectId: OBJECT_ID,
          printerCount: 1,
          autoRestart: true,
          changeoverMs,
        }),
      ],
      ...over,
    });

  it('burns the purge down and refuses to print in the meantime', () => {
    const next = tickSlots(purging(1000), content, 100, undefined);
    expect(next.slots[0]?.changeoverMs).toBe(900);
    expect(next.slots[0]?.run).toBeNull();
  });

  it('starts printing the moment the purge ends, spending the leftover tick', () => {
    // 40 ms of purge left, 100 ms of tick: 60 ms must land on the new run.
    const next = tickSlots(purging(40), content, 100, undefined);
    expect(next.slots[0]?.changeoverMs).toBe(0);
    const run = next.slots[0]?.run;
    expect(run).not.toBeNull();
    expect((run?.totalMs ?? 0) - (run?.remainingMs ?? 0)).toBe(60);
  });

  it('spends nothing on the run when the purge consumed the whole tick exactly', () => {
    const next = tickSlots(purging(100), content, 100, undefined);
    expect(next.slots[0]?.changeoverMs).toBe(0);
    expect(next.slots[0]?.run?.remainingMs).toBe(next.slots[0]?.run?.totalMs);
  });

  it('announces the end of the purge once', () => {
    const { events } = collectEvents((emit) => tickSlots(purging(40), content, 100, emit));
    expect(events.filter((event) => event.type === 'CHANGEOVER_COMPLETED')).toHaveLength(1);
  });

  /**
   * The property the whole `remainingDtMs` dance exists for: a purge that
   * straddles a tick boundary must not swallow simulation time.
   */
  it('loses no design time across the boundary', () => {
    const inOneGo = tickSlots(purging(140), content, 400, undefined);
    let stepped = purging(140);
    for (let i = 0; i < 4; i += 1) {
      stepped = tickSlots(stepped, content, 100, undefined);
    }
    expect(stepped.slots[0]?.run?.remainingMs).toBe(inOneGo.slots[0]?.run?.remainingMs);
  });
});

describe('failure inside the print loop', () => {
  const never: Content = {
    ...content,
    failure: { ...content.failure, model: { ...content.failure.model, strategy: 'never' } },
  };

  const printing = (over: Partial<GameState> = {}): GameState =>
    loaded('pla', {
      slots: [
        testSlot({ materialId: 'pla', objectId: OBJECT_ID, printerCount: 1, autoRestart: true }),
      ],
      ...over,
    });

  const runMs = (content.objects[0]?.printDesignSeconds ?? 12) * MS_PER_SECOND;

  it('accumulates charge on the slot as prints complete', () => {
    const after = tickSlots(printing(), content, runMs * 3, undefined);
    expect(after.slots[0]?.failureCharge).toBeGreaterThan(0);
  });

  it('eventually fails a print, banking scrap instead of parts', () => {
    // PLA charges 0.16 per print against a threshold of 1, so print 7 fails.
    const after = tickSlots(printing(), content, runMs * 8, undefined);
    expect(after.stats.printsFailed).toBeGreaterThan(0);
    expect(after.resources.scrap).toBeGreaterThan(0);
    expect(after.scrapValue).toBeGreaterThan(0);
    expect(after.stats.printsCompleted).toBe(8 - after.stats.printsFailed);
  });

  it('emits PRINT_FAILED alongside the completion it belongs to', () => {
    const { events } = collectEvents((emit) => tickSlots(printing(), content, runMs * 8, emit));
    const failures = events.filter((event) => event.type === 'PRINT_FAILED');
    const completions = events.filter((event) => event.type === 'PRINT_COMPLETED');
    expect(failures.length).toBeGreaterThan(0);
    expect(completions.length).toBeGreaterThanOrEqual(failures.length);
  });

  it('never fails when content turns the model off', () => {
    const after = tickSlots(printing(), never, runMs * 20, undefined);
    expect(after.stats.printsFailed).toBe(0);
    expect(after.resources.scrap).toBe(0);
  });

  it('is deterministic: the same run fails in exactly the same places', () => {
    const once = tickSlots(printing(), content, runMs * 20, undefined);
    const twice = tickSlots(printing(), content, runMs * 20, undefined);
    expect(twice.stats.printsFailed).toBe(once.stats.printsFailed);
    expect(twice.resources.scrap).toBe(once.resources.scrap);
  });

  it('fails less often with a failure-reducing node installed', () => {
    const bare = tickSlots(printing(), content, runMs * 40, undefined);
    const bedded = tickSlots(
      printing({ upgrades: { 'heated-bed': 1 } }),
      content,
      runMs * 40,
      undefined,
    );
    expect(bedded.stats.printsFailed).toBeLessThan(bare.stats.printsFailed);
  });
});
