import type { GameState } from '../state/game-state.js';

/**
 * Projection / Adapter (spec §15): the renderer is a pure function of this
 * versioned structure and may never read sim internals. M2 freezes v1 with real
 * per-slot entries; M0 ships the shape and the projection seam.
 */
export const VISUAL_STATE_VERSION = 1;

export interface SlotVisual {
  readonly slotId: string;
  readonly materialId: string;
  readonly objectId: string;
  readonly machineTier: number;
  readonly printerCount: number;
  /** 0..1 animation offset so identical printers do not move in lockstep. */
  readonly phaseOffset: number;
}

export interface VisualState {
  readonly version: number;
  readonly phaseId: string;
  readonly simTimeMs: number;
  readonly slots: readonly SlotVisual[];
}

export function toVisualState(state: GameState): VisualState {
  return {
    version: VISUAL_STATE_VERSION,
    phaseId: state.phaseId,
    simTimeMs: state.simTimeMs,
    slots: [],
  };
}
