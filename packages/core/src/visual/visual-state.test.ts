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
import { VISUAL_STATE_VERSION, toVisualState } from './visual-state.js';

const content = TEST_CONTENT;
const state = createInitialState(content, { seed: 1 });
const bracket = content.objects[0];
const pieces = content.start.assemblyPieces;

describe('toVisualState', () => {
  it('emits a versioned projection of the untouched workshop', () => {
    expect(toVisualState(state, content)).toEqual({
      version: VISUAL_STATE_VERSION,
      phaseId: 'intro',
      simTimeMs: 0,
      slots: [],
      assembly: {
        attachedPieceIds: [],
        totalPieces: pieces.length,
        nextPieceId: pieces[0]?.id,
        nextPieceName: pieces[0]?.name,
        cooldownMs: (pieces[0]?.attachDesignSeconds ?? 0) * 1000,
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

  it('tracks sim time so the renderer can animate without reading internals', () => {
    const sim = createSim().do(tick(100));
    expect(toVisualState(sim.state, content).simTimeMs).toBe(100);
  });

  it('reports assembly progress while the intro printer is being built', () => {
    const sim = createSim().tickSeconds(pieces[0]?.attachDesignSeconds ?? 0);
    sim.do({ type: 'ATTACH_PIECE', pieceId: pieces[0]?.id ?? '' });
    const visual = toVisualState(sim.state, content);
    expect(visual.assembly.attachedPieceIds).toEqual([pieces[0]?.id]);
    expect(visual.assembly.nextPieceId).toBe(pieces[1]?.id);
    expect(visual.assembly.complete).toBe(false);
    // No slot visual yet: the printer is not finished, so nothing is printing.
    expect(visual.slots).toEqual([]);
  });

  it('marks the assembly complete once every piece is attached', () => {
    const sim = assemblePrinter(createSim());
    const { assembly } = toVisualState(sim.state, content);
    expect(assembly.complete).toBe(true);
    expect(assembly.nextPieceId).toBeNull();
    expect(assembly.nextPieceName).toBeNull();
    expect(assembly.attachedPieceIds).toHaveLength(pieces.length);
  });

  it('renders once per configured slot, carrying the count badge (spec §4)', () => {
    const sim = assemblePrinter(createSim()).do(
      setSlotConfig(FIRST_SLOT_ID, FIRST_MATERIAL_ID, FIRST_OBJECT_ID),
    );
    const visual = toVisualState(sim.state, content);
    expect(visual.slots).toHaveLength(1);
    expect(visual.slots[0]).toMatchObject({
      slotId: FIRST_SLOT_ID,
      materialId: FIRST_MATERIAL_ID,
      objectId: FIRST_OBJECT_ID,
      machineTier: 1,
      printerCount: 1,
      running: false,
      progress: 0,
      batch: 0,
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
    // Both slots need a config and a printer before they project a visual.
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
