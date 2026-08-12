import type { Content } from '../content/schema.js';
import type { GameState } from '../state/game-state.js';
import { assemblyPieces, nextPiece } from '../systems/assembly.js';
import { bestPrinterTier, resolveSlotConfig, runProgress } from '../systems/printing.js';

/**
 * Projection / Adapter (spec §15): the renderer is a pure function of this
 * versioned structure and may never read sim internals. M2 freezes v2 with the
 * real vector printer; M1 fills it with the loop it now has to show.
 *
 * v2 (M1): per-slot run progress, the intro assembly and the HUD ledger.
 */
export const VISUAL_STATE_VERSION = 2;

export interface SlotVisual {
  readonly slotId: string;
  readonly materialId: string;
  readonly objectId: string;
  readonly machineTier: number;
  readonly printerCount: number;
  /** 0..1 animation offset so identical printers do not move in lockstep. */
  readonly phaseOffset: number;
  readonly running: boolean;
  /** 0..1 through the current batch. */
  readonly progress: number;
  readonly batch: number;
}

export interface AssemblyVisual {
  readonly attachedPieceIds: readonly string[];
  readonly totalPieces: number;
  readonly nextPieceId: string | null;
  readonly nextPieceName: string | null;
  /** Design-milliseconds of bench work left before the next piece attaches. */
  readonly cooldownMs: number;
  readonly complete: boolean;
}

export interface LedgerVisual {
  readonly parts: number;
  readonly money: number;
  readonly scrap: number;
  readonly filamentGrams: Readonly<Record<string, number>>;
}

export interface VisualState {
  readonly version: number;
  readonly phaseId: string;
  readonly simTimeMs: number;
  readonly slots: readonly SlotVisual[];
  readonly assembly: AssemblyVisual;
  readonly ledger: LedgerVisual;
}

/** Deterministic per-slot animation offset — no rng, no clock (spec §13). */
function phaseOffsetOf(index: number, total: number): number {
  return total > 0 ? index / total : 0;
}

export function toVisualState(state: GameState, content: Content): VisualState {
  const machineTier = bestPrinterTier(state, content);
  const slots: SlotVisual[] = [];
  state.slots.forEach((slot, index) => {
    const config = resolveSlotConfig(content, slot);
    if (config === null || slot.printerCount <= 0) {
      return;
    }
    slots.push({
      slotId: slot.id,
      materialId: config.material.id,
      objectId: config.object.id,
      machineTier,
      printerCount: slot.printerCount,
      phaseOffset: phaseOffsetOf(index, state.slots.length),
      running: slot.run !== null,
      progress: slot.run === null ? 0 : runProgress(slot.run),
      batch: slot.run?.batch ?? 0,
    });
  });

  const piece = nextPiece(state.assembly, content);
  return {
    version: VISUAL_STATE_VERSION,
    phaseId: state.phaseId,
    simTimeMs: state.simTimeMs,
    slots,
    assembly: {
      attachedPieceIds: state.assembly.attachedPieceIds,
      totalPieces: assemblyPieces(content).length,
      nextPieceId: piece?.id ?? null,
      nextPieceName: piece?.name ?? null,
      cooldownMs: state.assembly.cooldownMs,
      complete: piece === null,
    },
    ledger: {
      parts: state.resources.parts,
      money: state.resources.money,
      scrap: state.resources.scrap,
      filamentGrams: state.filamentGrams,
    },
  };
}
