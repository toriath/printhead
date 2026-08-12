import type { SlotVisual, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';

/**
 * The renderer is a *pure function of `VisualState`* (spec §1, §15). It never
 * imports the reducer, never reads sim internals and holds no state of its own.
 * M2 replaces these placeholders with the real vector printer; M1 pins the
 * contract, the per-slot rule (spec §4) and the test seam.
 */
export interface WorkshopProps {
  readonly visual: VisualState;
}

const SLOT_WIDTH = 120;
const SLOT_HEIGHT = 160;
const SLOT_GAP = 16;
const BAR_HEIGHT = 8;
const MAX_SLOTS = 4;

export function SlotView({ slot, x }: { slot: SlotVisual; x: number }): ReactElement {
  return (
    <g data-testid={`printer-${slot.slotId}`} transform={`translate(${x}, 0)`}>
      <rect
        width={SLOT_WIDTH}
        height={SLOT_HEIGHT}
        rx={6}
        className={`printer printer--tier-${slot.machineTier}${slot.running ? ' printer--running' : ''}`}
      />
      <rect
        data-testid={`progress-${slot.slotId}`}
        y={SLOT_HEIGHT - BAR_HEIGHT}
        width={SLOT_WIDTH * slot.progress}
        height={BAR_HEIGHT}
        className="printer__progress"
      />
      <text x={SLOT_WIDTH / 2} y={SLOT_HEIGHT - SLOT_GAP} textAnchor="middle">
        {`${slot.objectId} · ${slot.materialId} ×${slot.printerCount}`}
      </text>
    </g>
  );
}

/** The intro printer, drawn piece by piece as the player attaches them (spec §6). */
export function AssemblyView({ visual }: WorkshopProps): ReactElement {
  const { assembly } = visual;
  return (
    <g data-testid="assembly">
      {assembly.attachedPieceIds.map((pieceId, index) => (
        <rect
          key={pieceId}
          data-testid={`piece-${pieceId}`}
          x={SLOT_GAP}
          y={SLOT_HEIGHT - (index + 1) * (BAR_HEIGHT * 2)}
          width={SLOT_WIDTH}
          height={BAR_HEIGHT}
          className={`piece piece--${pieceId}`}
        />
      ))}
      <text data-testid="assembly-progress" x={SLOT_GAP} y={SLOT_GAP}>
        {`${assembly.attachedPieceIds.length}/${assembly.totalPieces} pieces`}
      </text>
    </g>
  );
}

export function Workshop({ visual }: WorkshopProps): ReactElement {
  return (
    <svg
      role="img"
      aria-label={`printhead workshop, phase ${visual.phaseId}`}
      data-visual-version={visual.version}
      data-phase={visual.phaseId}
      viewBox={`0 0 ${(SLOT_WIDTH + SLOT_GAP) * MAX_SLOTS} ${SLOT_HEIGHT}`}
    >
      <title>{`PRINTHEAD — ${visual.phaseId}`}</title>
      {visual.slots.map((slot, index) => (
        <SlotView key={slot.slotId} slot={slot} x={index * (SLOT_WIDTH + SLOT_GAP)} />
      ))}
      {visual.slots.length === 0 ? <AssemblyView visual={visual} /> : null}
    </svg>
  );
}
