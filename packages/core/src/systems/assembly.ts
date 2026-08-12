import type { AssemblyPieceDef, Content } from '../content/schema.js';
import { MS_PER_SECOND } from '../engine/constants.js';
import type { AssemblyState } from '../state/game-state.js';

/**
 * Intro assembly (spec §6 phase 0): 6–8 pieces attached one click at a time, in
 * content order, each gated by a stretch of bench work so the phase actually
 * takes its budgeted minutes. All timings live in `content/start.json`.
 *
 * Content authors design-seconds; the running countdown is kept in integer
 * milliseconds so it lands exactly on zero (see `AssemblyState`).
 */
const NONE = 0;

/** Bench work a piece needs, converted from authored seconds to tick units. */
export function attachCooldownMs(piece: AssemblyPieceDef | undefined): number {
  return (piece?.attachDesignSeconds ?? NONE) * MS_PER_SECOND;
}

export function assemblyPieces(content: Content): readonly AssemblyPieceDef[] {
  return content.start.assemblyPieces;
}

/** The piece the player may attach next, or `null` when the printer is finished. */
export function nextPiece(assembly: AssemblyState, content: Content): AssemblyPieceDef | null {
  return assemblyPieces(content).at(assembly.attachedPieceIds.length) ?? null;
}

export function isPieceReady(assembly: AssemblyState): boolean {
  return assembly.cooldownMs <= NONE;
}

export type AttachRejection = 'out-of-order' | 'not-ready';

export type AttachResult =
  | { readonly ok: true; readonly assembly: AssemblyState; readonly piece: AssemblyPieceDef }
  | { readonly ok: false; readonly reason: AttachRejection };

export function attachAssemblyPiece(
  assembly: AssemblyState,
  content: Content,
  pieceId: string,
): AttachResult {
  const piece = nextPiece(assembly, content);
  if (piece === null || piece.id !== pieceId) {
    return { ok: false, reason: 'out-of-order' };
  }
  if (!isPieceReady(assembly)) {
    return { ok: false, reason: 'not-ready' };
  }
  const attachedPieceIds = [...assembly.attachedPieceIds, piece.id];
  const following = assemblyPieces(content).at(attachedPieceIds.length);
  return {
    ok: true,
    piece,
    assembly: {
      attachedPieceIds,
      cooldownMs: attachCooldownMs(following),
    },
  };
}

/** Burn `dtMs` of bench work off the current piece's preparation. */
export function tickAssembly(assembly: AssemblyState, dtMs: number): AssemblyState {
  if (assembly.cooldownMs <= NONE) {
    return assembly;
  }
  return {
    ...assembly,
    cooldownMs: Math.max(assembly.cooldownMs - dtMs, NONE),
  };
}
