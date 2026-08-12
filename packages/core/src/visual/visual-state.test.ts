import { describe, expect, it } from 'vitest';
import {
  FIRST_MATERIAL_ID,
  FIRST_OBJECT_ID,
  FIRST_SLOT_ID,
  TEST_CONTENT,
  assemblePrinter,
  createSim,
} from '../state/__fixtures__/sim.js';
import { setSlotConfig, startPrint, tick } from '../state/actions.js';
import { type GameState, type SlotState, createInitialState } from '../state/game-state.js';
import { VISUAL_STATE_FIXTURES, visualFixture } from './fixtures.js';
import { VISUAL_STATE_VERSION, VisualStateSchema, validateVisualState } from './schema.js';
import { occupiedSlots, toVisualState } from './visual-state.js';

const content = TEST_CONTENT;
const state = createInitialState(content, { seed: 1 });
const bracket = content.objects[0];
const pieces = content.start.assemblyPieces;

describe('toVisualState', () => {
  it('emits a versioned projection of the untouched workshop', () => {
    expect(toVisualState(state, content)).toEqual({
      version: VISUAL_STATE_VERSION,
      phaseId: 'intro',
      phaseName: 'Intro',
      simTimeMs: 0,
      slotCapacity: content.start.maxSlotCount,
      slots: [
        {
          slotId: FIRST_SLOT_ID,
          index: 0,
          materialId: null,
          materialName: null,
          objectId: null,
          objectName: null,
          machineTier: 0,
          printerCount: 0,
          phaseOffset: 0,
          occupied: false,
          running: false,
          progress: 0,
          batch: 0,
        },
      ],
      assembly: {
        attachedPieceIds: [],
        totalPieces: pieces.length,
        nextPieceId: pieces[0]?.id,
        nextPieceName: pieces[0]?.name,
        cooldownMs: (pieces[0]?.attachDesignSeconds ?? 0) * 1000,
        ready: false,
        progress: 0,
        complete: false,
      },
      ledger: {
        parts: 0,
        money: 0,
        scrap: 0,
        filamentGrams: state.filamentGrams,
      },
    });
  });

  it('is a pure function of GameState', () => {
    expect(toVisualState(state, content)).toEqual(toVisualState(state, content));
  });

  it('carries the phase display name so the renderer holds no content table', () => {
    expect(toVisualState(state, content).phaseName).toBe(
      content.pacing.phases[0]?.name ?? '(missing)',
    );
  });

  it('tracks sim time so the renderer can animate without reading internals', () => {
    const sim = createSim().do(tick(100));
    expect(toVisualState(sim.state, content).simTimeMs).toBe(100);
  });

  it('publishes the hard slot cap so the renderer draws empty bays (spec §4)', () => {
    const visual = toVisualState(state, content);
    expect(visual.slotCapacity).toBe(content.start.maxSlotCount);
    expect(visual.slotCapacity).toBeGreaterThanOrEqual(visual.slots.length);
  });

  it('projects unconfigured slots as empty rather than hiding them', () => {
    const visual = toVisualState(state, content);
    expect(visual.slots).toHaveLength(state.slots.length);
    expect(visual.slots[0]?.occupied).toBe(false);
    expect(occupiedSlots(visual)).toEqual([]);
  });

  it('reports assembly progress while the intro printer is being built', () => {
    const sim = createSim().tickSeconds(pieces[0]?.attachDesignSeconds ?? 0);
    expect(toVisualState(sim.state, content).assembly.ready).toBe(true);
    sim.do({ type: 'ATTACH_PIECE', pieceId: pieces[0]?.id ?? '' });
    const visual = toVisualState(sim.state, content);
    expect(visual.assembly.attachedPieceIds).toEqual([pieces[0]?.id]);
    expect(visual.assembly.nextPieceId).toBe(pieces[1]?.id);
    expect(visual.assembly.progress).toBeCloseTo(1 / pieces.length);
    expect(visual.assembly.ready).toBe(false);
    expect(visual.assembly.complete).toBe(false);
    // The printer is not finished, so the bay is still empty.
    expect(occupiedSlots(visual)).toEqual([]);
  });

  it('marks the assembly complete once every piece is attached', () => {
    const sim = assemblePrinter(createSim());
    const { assembly } = toVisualState(sim.state, content);
    expect(assembly.complete).toBe(true);
    expect(assembly.ready).toBe(false);
    expect(assembly.progress).toBe(1);
    expect(assembly.nextPieceId).toBeNull();
    expect(assembly.nextPieceName).toBeNull();
    expect(assembly.attachedPieceIds).toHaveLength(pieces.length);
  });

  it('renders once per slot, carrying the count badge (spec §4)', () => {
    const sim = assemblePrinter(createSim()).do(
      setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID),
    );
    const visual = toVisualState(sim.state, content);
    expect(occupiedSlots(visual)).toHaveLength(1);
    expect(visual.slots[0]).toMatchObject({
      slotId: FIRST_SLOT_ID,
      index: 0,
      materialId: FIRST_MATERIAL_ID,
      materialName: content.materials[0]?.name,
      objectId: FIRST_OBJECT_ID,
      objectName: content.objects[0]?.name,
      machineTier: 1,
      printerCount: 1,
      occupied: true,
      running: false,
      progress: 0,
      batch: 0,
    });
  });

  it('leaves an unstaffed but configured slot empty and tierless', () => {
    const configured: GameState = {
      ...state,
      slots: [
        {
          id: FIRST_SLOT_ID,
          materialId: FIRST_MATERIAL_ID,
          objectId: FIRST_OBJECT_ID,
          printerCount: 0,
          autoRestart: false,
          run: null,
        },
      ],
    };
    expect(toVisualState(configured, content).slots[0]).toMatchObject({
      occupied: false,
      machineTier: 0,
      materialId: FIRST_MATERIAL_ID,
    });
  });

  it('exposes run progress between 0 and 1 while a batch prints', () => {
    const seconds = bracket?.printDesignSeconds ?? 1;
    const sim = assemblePrinter(createSim())
      .do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID))
      .do(startPrint(FIRST_SLOT_ID));
    expect(toVisualState(sim.state, content).slots[0]).toMatchObject({
      running: true,
      progress: 0,
      batch: 1,
    });

    sim.tickSeconds(seconds / 2);
    const halfway = toVisualState(sim.state, content).slots[0];
    expect(halfway?.progress).toBeGreaterThan(0);
    expect(halfway?.progress).toBeLessThan(1);
  });

  it('mirrors the HUD ledger', () => {
    const sim = assemblePrinter(createSim())
      .do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID))
      .do(startPrint(FIRST_SLOT_ID))
      .tickSeconds(bracket?.printDesignSeconds ?? 0);
    const { ledger } = toVisualState(sim.state, content);
    expect(ledger.parts).toBe(sim.state.resources.parts);
    expect(ledger.money).toBe(sim.state.resources.money);
    expect(ledger.scrap).toBe(sim.state.resources.scrap);
    expect(ledger.filamentGrams).toEqual(sim.state.filamentGrams);
  });

  it('gives each slot a distinct animation offset without rng or clock', () => {
    const occupied = (id: string): SlotState => ({
      id,
      materialId: FIRST_MATERIAL_ID,
      objectId: FIRST_OBJECT_ID,
      printerCount: 1,
      autoRestart: false,
      run: null,
    });
    const configured: GameState = {
      ...state,
      printers: { [content.start.printerId]: 2 },
      slots: [occupied(FIRST_SLOT_ID), occupied('slot-2')],
    };
    const offsets = toVisualState(configured, content).slots.map((slot) => slot.phaseOffset);
    expect(offsets).toEqual([0, 0.5]);
  });
});

describe('the frozen VisualState contract (spec §15)', () => {
  it('validates its own output against the frozen schema', () => {
    const sim = assemblePrinter(createSim())
      .do(setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID))
      .do(startPrint(FIRST_SLOT_ID))
      .tickSeconds(1);
    expect(validateVisualState(toVisualState(sim.state, content)).ok).toBe(true);
  });

  it('accepts every shipped fixture — that is what freezing means', () => {
    expect(VISUAL_STATE_FIXTURES.length).toBeGreaterThan(0);
    for (const fixture of VISUAL_STATE_FIXTURES) {
      expect(validateVisualState(fixture.visual), fixture.name).toMatchObject({ ok: true });
      expect(fixture.visual.version, fixture.name).toBe(VISUAL_STATE_VERSION);
    }
  });

  it('rejects an added field, so a silent shape change cannot ship', () => {
    const drifted = { ...visualFixture('printing'), extraField: 1 };
    const validation = validateVisualState(drifted);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.message).join(' ')).toContain('extraField');
  });

  it('rejects a removed field, so a silent shape change cannot ship', () => {
    const { ledger: _dropped, ...drifted } = visualFixture('printing');
    const validation = validateVisualState(drifted);
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.path)).toContain('ledger');
  });

  it('rejects an out-of-range progress value', () => {
    const fixture = visualFixture('printing');
    const broken = {
      ...fixture,
      slots: fixture.slots.map((slot) => ({ ...slot, progress: 1.5 })),
    };
    expect(validateVisualState(broken).ok).toBe(false);
  });

  it('rejects a document from a different version', () => {
    const stale = { ...visualFixture('fresh'), version: VISUAL_STATE_VERSION - 1 };
    expect(validateVisualState(stale).ok).toBe(false);
  });

  it('reports "(root)" for a wholesale mismatch instead of an empty path', () => {
    const validation = validateVisualState('not a visual state');
    expect(validation.ok).toBe(false);
    expect(validation.issues[0]?.path).toBe('(root)');
  });

  it('covers the states the renderer has to draw', () => {
    const byName = new Map(VISUAL_STATE_FIXTURES.map((f) => [f.name, f.visual]));
    expect([...byName.keys()]).toEqual([
      'fresh',
      'assembling',
      'assembled',
      'printing',
      'showcase',
    ]);
    // Machine-tier variants and count badges only exist in the showcase until
    // the sim can produce multiple slots and printer tiers (M4).
    const showcase = byName.get('showcase');
    expect(new Set(showcase?.slots.map((slot) => slot.machineTier))).toEqual(new Set([0, 1, 2, 3]));
    expect(showcase?.slots.some((slot) => slot.printerCount > 1)).toBe(true);
    expect(showcase?.slots.some((slot) => !slot.occupied)).toBe(true);
  });

  it('is exported as a schema so hosts can validate without importing the sim', () => {
    expect(VisualStateSchema.safeParse(visualFixture('showcase')).success).toBe(true);
  });

  it('throws a named error rather than shipping a fixture that drifted', () => {
    expect(() => visualFixture('nope')).toThrow(RangeError);
  });
});
