/**
 * Every coordinate the workshop is drawn from, in one place.
 *
 * These are *layout* numbers, not gameplay numbers — the no-literals rule
 * (spec §11) guards `core/src/systems`, where balance lives. Nothing here can
 * change what the simulation does; it can only change where a rectangle sits.
 * They are named and centralised anyway, because the STL generator (spec §20)
 * has to derive the physical printer's silhouette from these same shapes.
 */

/** One slot bay: the box a single printer visual is drawn inside. */
export const BAY_WIDTH = 160;
export const BAY_HEIGHT = 208;
export const BAY_GAP = 12;
export const BAY_PADDING = 6;

/** The machine itself, in bay-local coordinates. */
export const FRAME_X = 24;
export const FRAME_Y = 34;
export const FRAME_WIDTH = 112;
export const FRAME_HEIGHT = 118;
export const FRAME_UPRIGHT = 7;

export const BASE_X = 16;
export const BASE_Y = 152;
export const BASE_WIDTH = 128;
export const BASE_HEIGHT = 12;

export const GANTRY_Y = 66;
export const GANTRY_HEIGHT = 7;
export const GANTRY_INSET = 4;

export const CARRIAGE_WIDTH = 26;
export const CARRIAGE_HEIGHT = 18;
/** How far the print head sweeps along the gantry. */
export const CARRIAGE_TRAVEL = FRAME_WIDTH - CARRIAGE_WIDTH - GANTRY_INSET * 2;
export const CARRIAGE_HOME_X = FRAME_X + GANTRY_INSET;

export const NOZZLE_HEIGHT = 10;
export const NOZZLE_WIDTH = 9;

export const BED_X = 44;
export const BED_Y = 134;
export const BED_WIDTH = 72;
export const BED_HEIGHT = 7;
/** Tallest a printed object is drawn as it grows out of the bed. */
export const PRINT_MAX_HEIGHT = 40;
export const PRINT_WIDTH = 30;

export const SPOOL_CX = 40;
export const SPOOL_CY = 20;
export const SPOOL_R = 13;
export const SPOOL_HUB_R = 4;

/** The printer character (design system: Cast), drawn from 200 units into the bay. */
export const CHARACTER_SIZE = 168;
export const CHARACTER_Y = 4;

export const CONTROLLER_X = 96;
export const CONTROLLER_Y = 156;
export const CONTROLLER_WIDTH = 42;
export const CONTROLLER_HEIGHT = 14;

export const PROGRESS_Y = BAY_HEIGHT - 38;
export const PROGRESS_HEIGHT = 5;
export const LABEL_Y = BAY_HEIGHT - 7;
export const BADGE_R = 13;
export const BADGE_CX = BAY_WIDTH - 22;
export const BADGE_CY = 22;

/** The pity meter: a hairline under the progress bar (spec §7.1). */
export const RISK_Y = BAY_HEIGHT - 30;
export const RISK_HEIGHT = 2;

export const CORNER_RADIUS = 4;

/**
 * How much bigger the Goliath is than one bay of the rack (spec §5B). Big
 * enough that "the fleet became one machine" reads at a glance, small enough
 * that the whole thing still fits the same column the rack occupied.
 */
export const GOLIATH_SCALE = 2.2;

/** The rota strip drawn under a bay's label when a print queue is loaded. */
export const QUEUE_Y = BAY_HEIGHT - 6;
export const QUEUE_PIP_R = 3;
export const QUEUE_PIP_GAP = 10;

/**
 * The mint (spec §5E): a strip under the rack that appears only once a money
 * printer is installed, one bill per installed level. It is drawn *outside* the
 * bays because it is not a bay — nothing prints there, the Plates do.
 */
export const PRESS_HEIGHT = 44;
export const PRESS_PAD = 8;
export const BILL_WIDTH = 26;
export const BILL_HEIGHT = 15;
export const BILL_GAP = 6;
/** Negative animation delay per bill, so the strip does not pulse in lockstep. */
export const BILL_STAGGER_SECONDS = 0.4;

/**
 * The Universal Fabricator (spec §6 phase 6). It is drawn where the rack was —
 * the whole workshop is printing one thing — so it borrows the rack's column
 * width and is deliberately taller than a bay.
 */
export const FABRICATOR_WIDTH = 200;
export const FABRICATOR_HEIGHT = 260;
export const FABRICATOR_PAD = 14;
export const FABRICATOR_BAND_GAP = 1.5;

/** The ending sequence (spec §6): numbers, the museum shot, the credits. */
export const ENDING_WIDTH = 420;
export const ENDING_HEIGHT = 260;
export const ENDING_LINE_HEIGHT = 13;

/**
 * The backdrop the workshop is drawn against (spec §5E, "print a building").
 * A skyline of printed towers behind the rack: the widths and heights are a
 * fixed, deterministic silhouette, because a renderer may not roll dice.
 */
export const BACKDROP_HEIGHT = 96;
export const BACKDROP_TOWERS: readonly { readonly x: number; readonly height: number }[] = [
  { x: 0.02, height: 0.55 },
  { x: 0.13, height: 0.82 },
  { x: 0.24, height: 0.4 },
  { x: 0.34, height: 0.95 },
  { x: 0.47, height: 0.62 },
  { x: 0.58, height: 0.78 },
  { x: 0.7, height: 0.45 },
  { x: 0.8, height: 0.88 },
  { x: 0.91, height: 0.6 },
];
export const BACKDROP_TOWER_WIDTH = 0.08;

/** Total drawing width for `capacity` bays laid out in a row. */
export function workshopWidth(capacity: number): number {
  return capacity * BAY_WIDTH + Math.max(capacity - 1, 0) * BAY_GAP;
}

export function bayX(index: number): number {
  return index * (BAY_WIDTH + BAY_GAP);
}
