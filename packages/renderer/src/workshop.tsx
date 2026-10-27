import type { SlotVisual, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import type { FaceId } from './character-kit.js';
import { faceFor, kindFor } from './character.js';
import { Fabricator } from './fabricator.js';
import {
  BACKDROP_HEIGHT,
  BACKDROP_TOWERS,
  BACKDROP_TOWER_WIDTH,
  BASE_HEIGHT,
  BASE_Y,
  BAY_HEIGHT,
  BAY_PADDING,
  BAY_WIDTH,
  BILL_GAP,
  BILL_HEIGHT,
  BILL_STAGGER_SECONDS,
  BILL_WIDTH,
  CHARACTER_Y,
  FABRICATOR_HEIGHT,
  FABRICATOR_WIDTH,
  FLOOR_CREW_OFFSETS,
  FLOOR_CREW_SCALE,
  FLOOR_HEIGHT,
  FLOOR_SCALE_BACK,
  FLOOR_SCALE_FRONT,
  FLOOR_SPOTS,
  FLOOR_WIDTH,
  GOLIATH_SCALE,
  PILE_ITEM,
  PILE_MAX,
  PILE_PER_DOUBLING,
  PILE_ROW,
  PILE_X,
  PRESS_HEIGHT,
  PRESS_PAD,
  bayX,
  workshopWidth,
} from './geometry.js';
import { Printer } from './printer.js';
import { Slot } from './slot.js';
import { WORKSHOP_CSS } from './styles.js';
import { WorkshopWall } from './wall.js';

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
  /**
   * `rack` (the default) draws every bay as a box in a row, locked ones as
   * outlines. `floor` stands the owned bays' printers freely on the workshop
   * floor at `positions`, and draws nothing for bays not yet bought.
   */
  readonly layout?: 'rack' | 'floor';
  /** Floor positions by slot id, as fractions of the floor (feet, 0..1). */
  readonly positions?: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  /** The slot being dragged around the floor, drawn lifted. */
  readonly grabbedSlotId?: string | null;
}

/** Where a bay stands on the floor: its saved spot, or the next default one. */
export function floorSpot(
  slotId: string,
  index: number,
  positions: WorkshopProps['positions'],
): { readonly x: number; readonly y: number } {
  return positions?.[slotId] ?? FLOOR_SPOTS[index % FLOOR_SPOTS.length] ?? { x: 0.5, y: 0.8 };
}

export function floorScale(y: number): number {
  return FLOOR_SCALE_BACK + (FLOOR_SCALE_FRONT - FLOOR_SCALE_BACK) * y;
}

/**
 * Keep a printer wholly on the floor. Its feet are at `y`, so its head is a
 * bay's height (at that depth's scale) above them: the furthest back it may
 * stand is where the head touches the top edge. Sideways, half its scaled
 * width must stay inside either wall.
 */
export function clampToFloor(spot: { x: number; y: number }): { x: number; y: number } {
  const span = FLOOR_SCALE_FRONT - FLOOR_SCALE_BACK;
  const minY = (BAY_HEIGHT * FLOOR_SCALE_BACK) / (FLOOR_HEIGHT - BAY_HEIGHT * span);
  const y = Math.min(Math.max(spot.y, minY), 1);
  const half = (BAY_WIDTH * floorScale(y)) / 2 / FLOOR_WIDTH;
  const x = Math.min(Math.max(spot.x, half), 1 - half);
  return { x, y };
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

/** How many items a stock of `count` draws: a few per doubling, capped. */
export function pileSize(count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.min(PILE_MAX, Math.max(1, Math.round(PILE_PER_DOUBLING * Math.log2(count + 1))));
}

/** Row and column of the `index`-th item in a pyramid `PILE_ROW` wide. */
function pileCell(index: number): { row: number; col: number; width: number } {
  let row = 0;
  let left = index;
  let width = PILE_ROW;
  while (left >= width && width > 1) {
    left -= width;
    row += 1;
    width -= 1;
  }
  return { row, col: left, width };
}

/**
 * Finished stock, piling up on the floor: brackets for Parts, gilded boxes for
 * Products. Selling empties it — the pile is what the coins are made of.
 */
function StockPile({ visual }: { visual: VisualState }): ReactElement | null {
  const parts = pileSize(visual.ledger.parts);
  const products = pileSize(visual.ledger.products);
  const total = Math.min(parts + products, PILE_MAX);
  if (total === 0) {
    return null;
  }
  return (
    <g data-pile="true" data-testid="stock-pile" className="ph-pile">
      <ellipse
        className="ph-floor-shadow"
        cx={PILE_X + (PILE_ROW * PILE_ITEM) / 2}
        cy={FLOOR_HEIGHT - PILE_ITEM / 3}
        rx={(PILE_ROW * PILE_ITEM) / 2 + PILE_ITEM / 2}
        ry={PILE_ITEM / 2}
      />
      {Array.from({ length: total }, (_unused, index) => {
        const { row, col, width } = pileCell(index);
        const x = PILE_X + col * PILE_ITEM + ((PILE_ROW - width) * PILE_ITEM) / 2;
        const y = FLOOR_HEIGHT - (row + 1) * (PILE_ITEM - 2) - PILE_ITEM / 3;
        const product = index >= parts;
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: an item's place in the pile is its identity
            key={index}
            className={product ? 'ph-pile-item ph-pile-item--product' : 'ph-pile-item'}
            transform={`translate(${x}, ${y})`}
          >
            {product ? (
              <rect
                x={1}
                y={1}
                width={PILE_ITEM - 2}
                height={PILE_ITEM - 3}
                rx={2}
                className="ph-pile-box"
              />
            ) : (
              <path d={`M2 1h4v${PILE_ITEM - 8}h${PILE_ITEM - 8}v4H2z`} className="ph-pile-part" />
            )}
          </g>
        );
      })}
    </g>
  );
}

interface FloorItem {
  readonly key: string;
  readonly y: number;
  readonly node: ReactElement;
}

/**
 * Every printer on the floor, drawn in person (the floor lifts spec §4's
 * once-per-slot rule; the rack keeps it). Each bay is a crew: its lead stands
 * at the bay's spot carrying the bay's bars and label, the rest stand in
 * formation behind it, printing the same thing a beat out of step. All of
 * them, across all bays, are drawn back to front so nearer machines overlap
 * farther ones.
 */
function FloorCrews({
  visual,
  positions,
  grabbedSlotId,
  flourishes,
  onSlotPress,
  assemblyParts,
}: Pick<WorkshopProps, 'visual' | 'positions' | 'flourishes' | 'onSlotPress'> & {
  readonly grabbedSlotId: string | null;
  readonly assemblyParts?: readonly string[];
}): ReactElement {
  const items: FloorItem[] = [];
  visual.slots.forEach((slot, index) => {
    const spot = clampToFloor(floorSpot(slot.slotId, index, positions));
    const flourish = flourishes?.[slot.slotId];
    const grabbed = slot.slotId === grabbedSlotId;
    const lift = grabbed ? BAY_PADDING * 2 : 0;
    const place = (at: { x: number; y: number }, size = 1): string => {
      const scale = floorScale(at.y) * size;
      const x = at.x * FLOOR_WIDTH - (BAY_WIDTH * scale) / 2;
      const y = at.y * FLOOR_HEIGHT - BAY_HEIGHT * scale - lift;
      return `translate(${x}, ${y}) scale(${scale})`;
    };
    const className = grabbed ? 'ph-floor-spot is-grabbed' : 'ph-floor-spot';
    const crew = Math.max(slot.printerCount - 1, 0);
    const shown = Math.min(crew, FLOOR_CREW_OFFSETS.length);
    const press =
      onSlotPress !== undefined && slot.overclock.ready
        ? () => onSlotPress(slot.slotId)
        : undefined;
    for (let member = 0; member < shown; member += 1) {
      const offset = FLOOR_CREW_OFFSETS[member] ?? { x: 0, y: 0 };
      const at = clampToFloor({ x: spot.x + offset.x, y: spot.y + offset.y });
      items.push({
        key: `${slot.slotId}-crew-${member}`,
        y: at.y,
        node: (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the crew's lead is the keyboard target for its bay
          <g
            key={`${slot.slotId}-crew-${member}`}
            data-slot-id={slot.slotId}
            data-crew={member + 1}
            className={`${className} ph-crew${
              flourish === 'happy' || flourish === 'wow' ? ' ph-slot--celebrate' : ''
            }`}
            transform={place(at, FLOOR_CREW_SCALE)}
            onClick={press}
          >
            <ellipse
              className="ph-floor-shadow"
              cx={BAY_WIDTH / 2}
              cy={BASE_Y + BASE_HEIGHT + CHARACTER_Y * 2}
              rx={BAY_WIDTH * 0.42}
              ry={BAY_WIDTH * 0.07}
            />
            <Printer
              machineTier={slot.machineTier}
              parts="all"
              running={slot.running}
              // Each machine a beat out of step, so the crew reads as many.
              phaseOffset={(slot.phaseOffset + (member + 1) * 0.137) % 1}
              progress={slot.progress}
              output={slot.output}
              object={slot.objectId}
              material={slot.materialId}
              kind={kindFor(slot, false)}
              face={faceFor(slot, flourish)}
              overclocked={slot.overclock.active}
            />
          </g>
        ),
      });
    }
    items.push({
      key: slot.slotId,
      y: spot.y,
      node: (
        <g
          key={slot.slotId}
          data-slot-id={slot.slotId}
          data-lead="true"
          className={className}
          transform={place(spot)}
        >
          <Slot
            slot={slot}
            framed={false}
            selfAssembling={visual.assembly.selfAssembling}
            {...(index === 0 && assemblyParts !== undefined ? { assemblyParts } : {})}
            {...(flourish === undefined ? {} : { flourish })}
            {...(onSlotPress === undefined ? {} : { onPress: onSlotPress })}
          />
          {crew > shown ? (
            <text
              className="ph-crew-more"
              data-testid={`crew-more-${slot.slotId}`}
              x={BAY_WIDTH - BAY_PADDING}
              y={CHARACTER_Y + BAY_PADDING * 3}
              textAnchor="end"
            >
              {`+${crew - shown}`}
            </text>
          ) : null}
        </g>
      ),
    });
  });
  return <>{items.sort((a, b) => a.y - b.y).map((item) => item.node)}</>;
}

export function Workshop({
  visual,
  flourishes,
  onSlotPress,
  layout = 'rack',
  positions,
  grabbedSlotId = null,
}: WorkshopProps): ReactElement {
  const rack = bays(visual);
  const floor = layout === 'floor';
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
      : floor
        ? FLOOR_WIDTH
        : workshopWidth(rack.length);
  const rackHeight = building
    ? FABRICATOR_HEIGHT
    : visual.goliath
      ? BAY_HEIGHT * GOLIATH_SCALE
      : floor
        ? FLOOR_HEIGHT
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
      data-layout={building ? 'fabricator' : visual.goliath ? 'goliath' : layout}
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
      ) : floor ? (
        <>
          <WorkshopWall phaseId={visual.phaseId} />
          <StockPile visual={visual} />
          <FloorCrews
            visual={visual}
            {...(positions === undefined ? {} : { positions })}
            grabbedSlotId={grabbedSlotId}
            {...(flourishes === undefined ? {} : { flourishes })}
            {...(onSlotPress === undefined ? {} : { onSlotPress })}
            {...(assemblyParts === undefined ? {} : { assemblyParts })}
          />
        </>
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
