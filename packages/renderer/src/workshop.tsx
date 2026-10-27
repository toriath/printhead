import type { SlotVisual, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import type { FaceId } from './character-kit.js';
import { Fabricator } from './fabricator.js';
import {
  BACKDROP_HEIGHT,
  BACKDROP_TOWERS,
  BACKDROP_TOWER_WIDTH,
  BAY_HEIGHT,
  BILL_GAP,
  BILL_HEIGHT,
  BILL_STAGGER_SECONDS,
  BILL_WIDTH,
  FABRICATOR_HEIGHT,
  FABRICATOR_WIDTH,
  GOLIATH_SCALE,
  PRESS_HEIGHT,
  PRESS_PAD,
  bayX,
  workshopWidth,
} from './geometry.js';
import { Slot } from './slot.js';
import { WORKSHOP_CSS } from './styles.js';

/**
 * The workshop (spec §16: `renderer/` = Printer, Slot, Workshop, Goliath, …).
 *
 * The renderer is a **pure function of `VisualState`** (spec §1, §15): same
 * projection in, same markup out, no state, no clock, no content lookups and
 * no imports from the reducer. `workshop.test.tsx` asserts exactly that by
 * rendering the same fixture twice and comparing the HTML.
 *
 * Two layouts, chosen by data rather than by an id the renderer recognises: the
 * **rack** of up to four bays (spec §4) and the **Goliath** — one giant printer
 * that replaces the rack when the run's fork says so (spec §5B).
 */
export interface WorkshopProps {
  readonly visual: VisualState;
  /** Short-lived face reactions by slot id, derived from events by the shell. */
  readonly flourishes?: Readonly<Record<string, FaceId>>;
  /** Tap a printer to overclock its bay; omitted, the workshop is read-only. */
  readonly onSlotPress?: (slotId: string) => void;
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
    output: 'parts',
    designId: null,
    machineTier: 0,
    printerCount: 0,
    // A bay that does not exist yet holds nothing; the schema wants a positive
    // ceiling, and one is the smallest honest answer for "not bought".
    printerCapacity: 1,
    phaseOffset: capacity > 0 ? index / capacity : 0,
    occupied: false,
    running: false,
    progress: 0,
    batch: 0,
    changingOver: false,
    changeoverProgress: 0,
    failureRisk: 0,
    perfectCharge: 0,
    overclock: { active: false, remaining: 0, cooldown: 0, ready: false },
    queue: [],
    queueBatches: 0,
  };
}

export function bays(visual: VisualState): readonly SlotVisual[] {
  const capacity = Math.max(visual.slotCapacity, visual.slots.length);
  return Array.from(
    { length: capacity },
    (_unused, index) => visual.slots[index] ?? lockedBay(index, capacity),
  );
}

/**
 * The Goliath layout (spec §5B): the rack is gone and one machine fills the
 * frame. It is the same `Slot` component at a larger scale — the giant printer
 * is the *same printer*, which is exactly the joke the fork is making — so the
 * badge, the progress bar and the pity meter all keep working.
 */
function Goliath({ visual, flourishes, onSlotPress }: WorkshopProps): ReactElement | null {
  const slot = visual.slots[0];
  if (slot === undefined) {
    return null;
  }
  const flourish = flourishes?.[slot.slotId];
  return (
    <g data-testid="goliath" transform={`scale(${GOLIATH_SCALE})`}>
      <Slot
        slot={slot}
        goliath
        {...(flourish === undefined ? {} : { flourish })}
        {...(onSlotPress === undefined ? {} : { onPress: onSlotPress })}
      />
    </g>
  );
}

/**
 * One drawn bill per installed money-printer level, named by the press that
 * bought it (spec §5E). A flat list rather than a count, so each bill has a
 * stable identity — `bill-bill-printer-2` is *that* level of *that* tier, and
 * installing tier 2 does not renumber tier 1's bills.
 */
export function installedPresses(visual: VisualState): readonly string[] {
  return visual.moneyPrinters.flatMap((press) =>
    Array.from({ length: press.level }, (_unused, level) => `${press.moneyPrinterId}-${level + 1}`),
  );
}

/**
 * The mint (spec §5E). Once the Plates are printing money there is a machine
 * doing it, and it belongs in the workshop rather than in a number on a panel —
 * one bill per installed level, and the strip simply is not there before the
 * first press is bought.
 */
function Mint({ visual, width }: { visual: VisualState; width: number }): ReactElement | null {
  const bills = installedPresses(visual);
  if (bills.length === 0) {
    return null;
  }
  const span = bills.length * BILL_WIDTH + (bills.length - 1) * BILL_GAP;
  const left = Math.max((width - span) / 2, PRESS_PAD);
  return (
    <g
      data-testid="mint"
      data-press-levels={bills.length}
      data-plates={visual.ledger.plates}
      transform={`translate(0, ${BAY_HEIGHT})`}
    >
      <title>{`${bills.length} press level(s) · ${visual.prestige.platesHeld} plate(s)`}</title>
      {bills.map((bill, index) => (
        <rect
          key={bill}
          className="ph-bill"
          x={left + index * (BILL_WIDTH + BILL_GAP)}
          y={PRESS_PAD}
          width={BILL_WIDTH}
          height={BILL_HEIGHT}
          rx={2}
          // A negative delay desynchronises the strip without a clock, exactly
          // as `phaseOffset` does for the printers.
          style={{ animationDelay: `${-index * BILL_STAGGER_SECONDS}s` }}
        >
          <title>{bill}</title>
        </rect>
      ))}
    </g>
  );
}

/**
 * What the workshop is drawn against (spec §5E: "print a building (backdrop
 * change)"). The renderer is handed a backdrop *id* and decides what that looks
 * like — presentation, not simulation — so a new backdrop is a row here and a
 * row in `endgame.json`, and an id with no drawing simply has none.
 */
function Backdrop({ visual, width }: { visual: VisualState; width: number }): ReactElement | null {
  if (visual.backdrop !== 'skyline') {
    return null;
  }
  return (
    <g data-testid="backdrop" data-backdrop={visual.backdrop} className="ph-backdrop">
      <title>A printed city</title>
      {BACKDROP_TOWERS.map((tower) => (
        <rect
          key={tower.x}
          className="ph-backdrop-tower"
          x={tower.x * width}
          y={BACKDROP_HEIGHT * (1 - tower.height)}
          width={BACKDROP_TOWER_WIDTH * width}
          height={BACKDROP_HEIGHT * tower.height}
        />
      ))}
    </g>
  );
}

export function Workshop({ visual, flourishes, onSlotPress }: WorkshopProps): ReactElement {
  const rack = bays(visual);
  /*
   * The final print takes the whole frame (spec §4: "a deliberate return to
   * total commitment"). Every bay was cleared to start it, so drawing the rack
   * underneath would be drawing machines that are not printing anything.
   */
  const building = visual.fabricator.running || visual.fabricator.complete;
  const width = building
    ? FABRICATOR_WIDTH
    : visual.goliath
      ? workshopWidth(1) * GOLIATH_SCALE
      : workshopWidth(rack.length);
  const rackHeight = building
    ? FABRICATOR_HEIGHT
    : visual.goliath
      ? BAY_HEIGHT * GOLIATH_SCALE
      : BAY_HEIGHT;
  const height = rackHeight + (installedPresses(visual).length > 0 ? PRESS_HEIGHT : 0);
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
      data-layout={building ? 'fabricator' : visual.goliath ? 'goliath' : 'rack'}
      data-backdrop={visual.backdrop}
      data-self-assembling={visual.assembly.selfAssembling}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{`PRINTHEAD — ${visual.phaseName}`}</title>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a constant stylesheet, never user input */}
      <style dangerouslySetInnerHTML={{ __html: WORKSHOP_CSS }} />
      <Backdrop visual={visual} width={width} />
      {building ? (
        <Fabricator visual={visual} />
      ) : visual.goliath ? (
        <Goliath
          visual={visual}
          {...(flourishes === undefined ? {} : { flourishes })}
          {...(onSlotPress === undefined ? {} : { onSlotPress })}
        />
      ) : (
        rack.map((slot, index) => {
          const flourish = flourishes?.[slot.slotId];
          return (
            <g key={slot.slotId} transform={`translate(${bayX(index)}, 0)`}>
              <Slot
                slot={slot}
                selfAssembling={visual.assembly.selfAssembling}
                {...(index === 0 && assemblyParts !== undefined ? { assemblyParts } : {})}
                {...(flourish === undefined ? {} : { flourish })}
                {...(onSlotPress === undefined ? {} : { onPress: onSlotPress })}
              />
            </g>
          );
        })
      )}
      <Mint visual={visual} width={width} />
    </svg>
  );
}
