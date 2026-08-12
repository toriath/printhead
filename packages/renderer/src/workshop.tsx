import type { SlotVisual, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';

/**
 * The renderer is a *pure function of `VisualState`* (spec §1, §15). It never
 * imports the reducer, never reads sim internals and holds no state of its own.
 * M2 replaces these placeholders with the real vector printer; M0 pins the
 * contract and the test seam.
 */
export interface WorkshopProps {
  readonly visual: VisualState;
}

const SLOT_WIDTH = 120;
const SLOT_HEIGHT = 160;
const SLOT_GAP = 16;

export function SlotView({ slot, x }: { slot: SlotVisual; x: number }): ReactElement {
  return (
    <g data-testid={`printer-${slot.slotId}`} transform={`translate(${x}, 0)`}>
      <rect
        width={SLOT_WIDTH}
        height={SLOT_HEIGHT}
        rx={6}
        className={`printer printer--tier-${slot.machineTier}`}
      />
      <text x={SLOT_WIDTH / 2} y={SLOT_HEIGHT - SLOT_GAP} textAnchor="middle">
        {`${slot.objectId} · ${slot.materialId} ×${slot.printerCount}`}
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
      viewBox={`0 0 ${(SLOT_WIDTH + SLOT_GAP) * 4} ${SLOT_HEIGHT}`}
    >
      <title>{`PRINTHEAD — ${visual.phaseId}`}</title>
      {visual.slots.map((slot, index) => (
        <SlotView key={slot.slotId} slot={slot} x={index * (SLOT_WIDTH + SLOT_GAP)} />
      ))}
      {visual.slots.length === 0 ? (
        <text data-testid="empty-workshop" x={SLOT_GAP} y={SLOT_HEIGHT / 2}>
          no printers yet
        </text>
      ) : null}
    </svg>
  );
}
