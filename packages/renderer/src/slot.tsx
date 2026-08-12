import type { SlotVisual } from '@printhead/core';
import type { ReactElement } from 'react';
import {
  BADGE_CX,
  BADGE_CY,
  BADGE_R,
  BAY_HEIGHT,
  BAY_PADDING,
  BAY_WIDTH,
  CORNER_RADIUS,
  LABEL_Y,
  PROGRESS_HEIGHT,
  PROGRESS_Y,
} from './geometry.js';
import { Printer } from './printer.js';

/**
 * One config-slot bay (spec §4 rendering rule).
 *
 * **Once per slot, never once per printer.** Seven printers in a slot are one
 * animated machine plus a `×7` badge — that rule is the reason the projection
 * is slot-shaped in the first place. A slot with no config or no printers is
 * drawn as a faint outline so the fleet's shape is always legible.
 */
export interface SlotProps {
  readonly slot: SlotVisual;
  /** Parts to draw during the intro; omitted once the machine is finished. */
  readonly assemblyParts?: readonly string[];
}

const SINGLE = 1;

export function CountBadge({ count }: { count: number }): ReactElement | null {
  if (count <= SINGLE) {
    return null;
  }
  return (
    <g data-testid="count-badge">
      <circle className="ph-badge-disc" cx={BADGE_CX} cy={BADGE_CY} r={BADGE_R} />
      <text
        className="ph-badge-text"
        x={BADGE_CX}
        y={BADGE_CY}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {`×${count}`}
      </text>
    </g>
  );
}

function ProgressBar({ progress }: { progress: number }): ReactElement {
  const width = (BAY_WIDTH - BAY_PADDING * 2) * Math.min(Math.max(progress, 0), 1);
  return (
    <g data-testid="progress-bar">
      <rect
        className="ph-progress-track"
        x={BAY_PADDING}
        y={PROGRESS_Y}
        width={BAY_WIDTH - BAY_PADDING * 2}
        height={PROGRESS_HEIGHT}
        rx={PROGRESS_HEIGHT / 2}
      />
      <rect
        className="ph-progress-fill"
        x={BAY_PADDING}
        y={PROGRESS_Y}
        width={width}
        height={PROGRESS_HEIGHT}
        rx={PROGRESS_HEIGHT / 2}
      />
    </g>
  );
}

export function slotLabel(slot: SlotVisual): string {
  const config = `${slot.objectName ?? slot.objectId} · ${slot.materialName ?? slot.materialId}`;
  if (slot.occupied) {
    return config;
  }
  if (slot.materialId !== null) {
    return `${config} (no printer)`;
  }
  return slot.printerCount > 0 ? 'no config loaded' : 'empty bay';
}

export function Slot({ slot, assemblyParts }: SlotProps): ReactElement {
  const assembling = assemblyParts !== undefined;
  // A machine the player owns is always on screen, configured or not.
  const drawMachine = slot.printerCount > 0 || assembling;
  return (
    <g
      data-testid={`slot-${slot.slotId}`}
      data-occupied={slot.occupied}
      data-slot-index={slot.index}
    >
      <rect
        data-testid={`bay-${slot.slotId}`}
        className={drawMachine ? 'ph-bay' : 'ph-bay ph-bay--empty'}
        x={0}
        y={0}
        width={BAY_WIDTH}
        height={BAY_HEIGHT}
        rx={CORNER_RADIUS * 2}
      />
      {drawMachine ? (
        <Printer
          machineTier={slot.machineTier}
          parts={assemblyParts ?? 'all'}
          running={slot.running}
          phaseOffset={slot.phaseOffset}
          progress={slot.progress}
        />
      ) : null}
      {slot.occupied ? <ProgressBar progress={slot.progress} /> : null}
      <CountBadge count={slot.printerCount} />
      <text
        data-testid={`label-${slot.slotId}`}
        className={slot.occupied ? 'ph-label' : 'ph-label ph-label--dim'}
        x={BAY_WIDTH / 2}
        y={LABEL_Y}
        textAnchor="middle"
      >
        {assembling ? 'assembling…' : slotLabel(slot)}
      </text>
    </g>
  );
}
