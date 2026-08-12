import type { SlotVisual, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import { BAY_HEIGHT, bayX, workshopWidth } from './geometry.js';
import { Slot } from './slot.js';
import { WORKSHOP_CSS } from './styles.js';

/**
 * The workshop (spec §16: `renderer/` = Printer, Slot, Workshop, …).
 *
 * The renderer is a **pure function of `VisualState`** (spec §1, §15): same
 * projection in, same markup out, no state, no clock, no content lookups and
 * no imports from the reducer. `workshop.test.tsx` asserts exactly that by
 * rendering the same fixture twice and comparing the HTML.
 */
export interface WorkshopProps {
  readonly visual: VisualState;
}

const EMPTY_BAY_ID = 'locked';

/**
 * Bays past the ones the save actually owns. Spec §4 caps config slots at four
 * and asks for empty ones as faint outlines, so the workshop always shows the
 * whole rack — the shape of the fleet is part of the information.
 */
function lockedBay(index: number, capacity: number): SlotVisual {
  return {
    slotId: `${EMPTY_BAY_ID}-${index + 1}`,
    index,
    materialId: null,
    materialName: null,
    objectId: null,
    objectName: null,
    machineTier: 0,
    printerCount: 0,
    phaseOffset: capacity > 0 ? index / capacity : 0,
    occupied: false,
    running: false,
    progress: 0,
    batch: 0,
    changingOver: false,
    changeoverProgress: 0,
    failureRisk: 0,
  };
}

export function bays(visual: VisualState): readonly SlotVisual[] {
  const capacity = Math.max(visual.slotCapacity, visual.slots.length);
  return Array.from(
    { length: capacity },
    (_unused, index) => visual.slots[index] ?? lockedBay(index, capacity),
  );
}

export function Workshop({ visual }: WorkshopProps): ReactElement {
  const rack = bays(visual);
  const width = workshopWidth(rack.length);
  // During the intro the first bay holds the machine being built: the pieces
  // the player has clicked on, drawn on the printer that will keep them
  // company for the rest of the game (spec §6 phase 0).
  const assemblyParts = visual.assembly.complete ? undefined : visual.assembly.attachedPieceIds;

  return (
    <svg
      className="printhead-workshop"
      role="img"
      aria-label={`PRINTHEAD workshop — ${visual.phaseName}`}
      data-visual-version={visual.version}
      data-phase={visual.phaseId}
      data-slot-capacity={visual.slotCapacity}
      viewBox={`0 0 ${width} ${BAY_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{`PRINTHEAD — ${visual.phaseName}`}</title>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant stylesheet, never user input */}
      <style dangerouslySetInnerHTML={{ __html: WORKSHOP_CSS }} />
      {rack.map((slot, index) => (
        <g key={slot.slotId} transform={`translate(${bayX(index)}, 0)`}>
          <Slot
            slot={slot}
            {...(index === 0 && assemblyParts !== undefined ? { assemblyParts } : {})}
          />
        </g>
      ))}
    </svg>
  );
}
