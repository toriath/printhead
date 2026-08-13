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
  QUEUE_PIP_GAP,
  QUEUE_PIP_R,
  QUEUE_Y,
  RISK_HEIGHT,
  RISK_Y,
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
  /**
   * The workshop is rebuilding itself after a melt-down (spec §6 phase 4), so
   * the intro caption says so instead of inviting a click that never comes.
   */
  readonly selfAssembling?: boolean;
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

function ProgressBar({ progress, purging }: { progress: number; purging: boolean }): ReactElement {
  const width = (BAY_WIDTH - BAY_PADDING * 2) * Math.min(Math.max(progress, 0), 1);
  return (
    <g data-testid="progress-bar" data-purging={purging}>
      <rect
        className="ph-progress-track"
        x={BAY_PADDING}
        y={PROGRESS_Y}
        width={BAY_WIDTH - BAY_PADDING * 2}
        height={PROGRESS_HEIGHT}
        rx={PROGRESS_HEIGHT / 2}
      />
      <rect
        className={purging ? 'ph-progress-fill ph-progress-fill--purge' : 'ph-progress-fill'}
        x={BAY_PADDING}
        y={PROGRESS_Y}
        width={width}
        height={PROGRESS_HEIGHT}
        rx={PROGRESS_HEIGHT / 2}
      />
    </g>
  );
}

/**
 * The pity meter (spec §7.1). Failure is a deterministic charge, not a dice
 * roll, so the player is *entitled* to see it filling — the whole design intent
 * is that a bad print is something you watched coming.
 */
function RiskMeter({ risk }: { risk: number }): ReactElement | null {
  if (risk <= 0) {
    return null;
  }
  const width = (BAY_WIDTH - BAY_PADDING * 2) * Math.min(risk, 1);
  return (
    <g data-testid="risk-meter" data-risk={risk.toFixed(2)}>
      <rect
        className="ph-risk-track"
        x={BAY_PADDING}
        y={RISK_Y}
        width={BAY_WIDTH - BAY_PADDING * 2}
        height={RISK_HEIGHT}
      />
      <rect
        className="ph-risk-fill"
        x={BAY_PADDING}
        y={RISK_Y}
        width={width}
        height={RISK_HEIGHT}
      />
    </g>
  );
}

/**
 * The print rota (spec §5B) as a row of pips, the loaded entry filled in. A
 * queue is a promise about what the bay will do next, so it belongs on the bay
 * rather than in a panel somewhere else.
 */
function QueueStrip({ slot }: { slot: SlotVisual }): ReactElement | null {
  if (slot.queue.length <= SINGLE) {
    return null;
  }
  const span = (slot.queue.length - SINGLE) * QUEUE_PIP_GAP;
  const left = (BAY_WIDTH - span) / 2;
  return (
    <g data-testid={`queue-${slot.slotId}`} data-queue-length={slot.queue.length}>
      {slot.queue.map((entry, index) => (
        <circle
          key={`${entry.materialId}-${entry.objectId}-${index}`}
          className={entry.current ? 'ph-queue-pip ph-queue-pip--current' : 'ph-queue-pip'}
          cx={left + index * QUEUE_PIP_GAP}
          cy={QUEUE_Y}
          r={QUEUE_PIP_R}
        >
          <title>{`${entry.objectName} · ${entry.materialName} ×${entry.batches}`}</title>
        </circle>
      ))}
    </g>
  );
}

export function slotLabel(slot: SlotVisual): string {
  const name = slot.objectName ?? slot.objectId;
  // A Design is a thing the player made, so it is named as one (spec §5D).
  const config = `${slot.designId === null ? name : `⌗ ${name}`} · ${slot.materialName ?? slot.materialId}`;
  if (slot.changingOver) {
    return `purging → ${slot.materialName ?? slot.materialId}`;
  }
  if (slot.occupied) {
    return config;
  }
  if (slot.materialId !== null) {
    return `${config} (no printer)`;
  }
  return slot.printerCount > 0 ? 'no config loaded' : 'empty bay';
}

export function Slot({ slot, assemblyParts, selfAssembling = false }: SlotProps): ReactElement {
  const assembling = assemblyParts !== undefined;
  // A machine the player owns is always on screen, configured or not.
  const drawMachine = slot.printerCount > 0 || assembling;
  return (
    <g
      data-testid={`slot-${slot.slotId}`}
      data-occupied={slot.occupied}
      data-slot-index={slot.index}
      data-output={slot.output}
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
          output={slot.output}
        />
      ) : null}
      {slot.occupied ? (
        <ProgressBar
          // During a purge the bar tracks the changeover, not a print: the bay
          // is busy either way and an empty bar would read as "idle".
          progress={slot.changingOver ? slot.changeoverProgress : slot.progress}
          purging={slot.changingOver}
        />
      ) : null}
      {slot.occupied ? <RiskMeter risk={slot.failureRisk} /> : null}
      <CountBadge count={slot.printerCount} />
      <text
        data-testid={`label-${slot.slotId}`}
        className={slot.occupied ? 'ph-label' : 'ph-label ph-label--dim'}
        x={BAY_WIDTH / 2}
        y={LABEL_Y}
        textAnchor="middle"
      >
        {assembling ? (selfAssembling ? 'self-assembling…' : 'assembling…') : slotLabel(slot)}
      </text>
      <QueueStrip slot={slot} />
    </g>
  );
}
