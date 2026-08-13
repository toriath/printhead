import { describe, expect, it } from 'vitest';
import type { MaterialDef, ObjectDef } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import { TEST_CONTENT, testSlot } from '../state/__fixtures__/sim.js';
import { type GameState, type SlotState, createInitialState } from '../state/game-state.js';
import {
  type SlotConfig,
  affordableBatch,
  batchYield,
  bestPrinterTier,
  bestSpeedMultiplier,
  filamentPerBatch,
  isRunComplete,
  resolveSlotConfig,
  runDesignMs,
  runProgress,
  slotIndexOf,
  startRun,
  tickRun,
  withSlot,
} from './printing.js';

const content = TEST_CONTENT;
const base = createInitialState(content, { seed: 1 });
/** Nothing installed: the fleet's own numbers, unmodified. */
const bare = new Map<never, never>();
/** Prices are only devalued once phase 5 arrives (spec §6); the index is 1 here. */
const NO_INFLATION = 1;
const curves = createCurveRegistry(content.curves);

const material = (over: Partial<MaterialDef> = {}): MaterialDef =>
  ({ ...content.materials[0], ...over }) as MaterialDef;
const object = (over: Partial<ObjectDef> = {}): ObjectDef =>
  ({ ...content.objects[0], ...over }) as ObjectDef;

/**
 * A loaded bay's flattened recipe, built the way the sim builds it — printing
 * reads `printDesignSeconds`/`filamentGrams` off the config, not off the def,
 * so a test that hand-rolled the object would stop measuring the real path.
 */
const config = (
  over: { material?: Partial<MaterialDef>; object?: Partial<ObjectDef> } = {},
): SlotConfig => {
  const obj = object(over.object);
  return {
    material: material(over.material),
    object: obj,
    design: null,
    recipeId: obj.id,
    recipeName: obj.name,
    printDesignSeconds: obj.printDesignSeconds,
    filamentGrams: obj.filamentGrams,
    pool: 'parts',
  };
};

/** A bay loaded with a Design instead: it makes Products (spec §5D). */
const designConfig = (): SlotConfig => {
  const def = content.designs[0];
  if (def === undefined) {
    throw new Error('expected a design in content');
  }
  return {
    material: material({ id: def.requiredMaterialId }),
    object: null,
    design: { ...def, baseProductValue: 100, levelValueCurveId: 'design-level-value' },
    recipeId: def.id,
    recipeName: def.name,
    printDesignSeconds: def.printDesignSeconds,
    filamentGrams: def.filamentGrams,
    pool: 'products',
  };
};

describe('resolveSlotConfig', () => {
  it('resolves a configured slot to its defs', () => {
    const resolved = resolveSlotConfig(
      content,
      testSlot({ printerCount: 1, materialId: 'pla', objectId: 'bracket' }),
    );
    expect(resolved?.material.id).toBe('pla');
    expect(resolved?.object?.id).toBe('bracket');
    expect(resolved?.recipeId).toBe('bracket');
    expect(resolved?.pool).toBe('parts');
  });

  it('is null for an unconfigured or dangling slot', () => {
    expect(resolveSlotConfig(content, testSlot({ objectId: 'bracket' }))).toBeNull();
    expect(resolveSlotConfig(content, testSlot({ materialId: 'pla' }))).toBeNull();
    expect(
      resolveSlotConfig(content, testSlot({ materialId: 'ghost', objectId: 'bracket' })),
    ).toBeNull();
    expect(
      resolveSlotConfig(content, testSlot({ materialId: 'pla', objectId: 'ghost' })),
    ).toBeNull();
  });
});

describe('the owned fleet decides tier and speed', () => {
  it('is zero when nothing is owned', () => {
    expect(bestPrinterTier(base, content, bare)).toBe(0);
    expect(bestSpeedMultiplier(base, content, bare)).toBe(0);
  });

  it('takes the best machine, not the last or the sum', () => {
    const owned = { ...base, printers: { 'bench-mk1': 3 } };
    const printer = content.printers[0];
    expect(bestPrinterTier(owned, content, bare)).toBe(printer?.machineTier);
    expect(bestSpeedMultiplier(owned, content, bare)).toBe(printer?.speedMultiplier);
  });

  it('ignores printer defs that are not owned', () => {
    expect(bestPrinterTier({ ...base, printers: { 'bench-mk1': 0 } }, content, bare)).toBe(0);
  });
});

describe('runDesignMs', () => {
  it('converts authored design-seconds into milliseconds', () => {
    const c = config({ object: { printDesignSeconds: 12 }, material: { printSpeedMultiplier: 1 } });
    expect(runDesignMs(c, 1)).toBe(12 * MS_PER_SECOND);
  });

  it('divides by the combined material and machine speed', () => {
    const c = config({ object: { printDesignSeconds: 12 }, material: { printSpeedMultiplier: 2 } });
    expect(runDesignMs(c, 3)).toBe((12 * MS_PER_SECOND) / 6);
  });

  it('refuses a non-positive speed rather than dividing by zero', () => {
    expect(() => runDesignMs(config({ material: { printSpeedMultiplier: 0 } }), 1)).toThrow(
      RangeError,
    );
    expect(() => runDesignMs(config(), -1)).toThrow(/print speed must be positive/);
  });
});

describe('batching', () => {
  it('consumes filament per print in the batch', () => {
    expect(filamentPerBatch(config({ object: { filamentGrams: 4 } }), 5)).toBe(20);
  });

  it('limits the batch to the printers or the filament, whichever is scarcer', () => {
    const c = config({ object: { filamentGrams: 4 } });
    expect(affordableBatch(c, 3, 100)).toBe(3);
    expect(affordableBatch(c, 10, 18)).toBe(4);
    expect(affordableBatch(c, 10, 0)).toBe(0);
  });

  it('refuses a recipe that consumes no filament', () => {
    expect(() => affordableBatch(config({ object: { filamentGrams: 0 } }), 1, 10)).toThrow(
      RangeError,
    );
  });

  it('yields parts and value scaled by the batch and the material', () => {
    const c = config({
      object: { partsYield: 2, basePartValue: 3 },
      material: { valueMultiplier: 1.5 },
    });
    expect(batchYield(c, 4, bare, curves, 0, NO_INFLATION)).toEqual({
      count: 8,
      value: 8 * 3 * 1.5,
      pool: 'parts',
    });
  });

  it('yields Products from a Design, valued by its level (spec §5D)', () => {
    const c = designConfig();
    // One Product per print, and the level curve reads 1× at level 1.
    expect(batchYield(c, 3, bare, curves, 1, NO_INFLATION)).toEqual({
      count: 3,
      value: 300,
      pool: 'products',
    });
    // A higher level is worth strictly more per Product, from content alone.
    const levelled = batchYield(c, 3, bare, curves, 4, NO_INFLATION);
    expect(levelled.value).toBeGreaterThan(300);
    expect(levelled.pool).toBe('products');
  });
});

describe('a run advances in whole ticks', () => {
  const c = config({ object: { printDesignSeconds: 12 }, material: { printSpeedMultiplier: 1 } });

  it('starts with the full duration and no carry', () => {
    const run = startRun(c, 2, 1, 0);
    expect(run).toEqual({ remainingMs: 12_000, totalMs: 12_000, batch: 2 });
  });

  it('rolls the previous run overshoot into the next one', () => {
    // A run that finished 250 ms past due starts the next 250 ms ahead.
    expect(startRun(c, 1, 1, -250).remainingMs).toBe(11_750);
  });

  it('lands exactly on zero after the right number of 100 ms ticks', () => {
    let run = startRun(c, 1, 1, 0);
    for (let i = 0; i < 120; i += 1) {
      run = tickRun(run, 100);
    }
    // Exactly zero, not 1e-15: this is why the clock is milliseconds, not seconds.
    expect(run.remainingMs).toBe(0);
    expect(isRunComplete(run)).toBe(true);
  });

  it('is not complete one tick early', () => {
    let run = startRun(c, 1, 1, 0);
    for (let i = 0; i < 119; i += 1) {
      run = tickRun(run, 100);
    }
    expect(run.remainingMs).toBe(100);
    expect(isRunComplete(run)).toBe(false);
  });
});

describe('runProgress', () => {
  const c = config({ object: { printDesignSeconds: 10 }, material: { printSpeedMultiplier: 1 } });

  it('reports 0 at the start and 1 at the end', () => {
    const run = startRun(c, 1, 1, 0);
    expect(runProgress(run)).toBe(0);
    expect(runProgress({ ...run, remainingMs: 0 })).toBe(1);
  });

  it('interpolates in between', () => {
    const run = startRun(c, 1, 1, 0);
    expect(runProgress({ ...run, remainingMs: 2_500 })).toBeCloseTo(0.75, 9);
  });

  it('clamps rather than reporting past the ends', () => {
    const run = startRun(c, 1, 1, 0);
    expect(runProgress({ ...run, remainingMs: -5_000 })).toBe(1);
    expect(runProgress({ ...run, remainingMs: 20_000 })).toBe(0);
  });

  it('reads a zero-length run as finished', () => {
    expect(runProgress({ remainingMs: 0, totalMs: 0, batch: 1 })).toBe(1);
  });
});

describe('slot addressing', () => {
  it('finds a slot by id and reports -1 for an unknown one', () => {
    expect(slotIndexOf(base, base.slots[0]?.id ?? '')).toBe(0);
    expect(slotIndexOf(base, 'slot-99')).toBe(-1);
  });

  it('replaces exactly one slot and leaves the rest identical', () => {
    const second: SlotState = testSlot({ id: 'slot-2' });
    const two: GameState = { ...base, slots: [...base.slots, second] };
    const next = withSlot(two, 1, { ...second, printerCount: 7 });
    expect(next.slots[1]?.printerCount).toBe(7);
    expect(next.slots[0]).toBe(two.slots[0]);
  });
});
