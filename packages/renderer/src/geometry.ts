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

export const CONTROLLER_X = 96;
export const CONTROLLER_Y = 156;
export const CONTROLLER_WIDTH = 42;
export const CONTROLLER_HEIGHT = 14;

export const PROGRESS_Y = BAY_HEIGHT - 26;
export const PROGRESS_HEIGHT = 5;
export const LABEL_Y = BAY_HEIGHT - 12;
export const BADGE_R = 13;
export const BADGE_CX = BAY_WIDTH - 22;
export const BADGE_CY = 22;

export const CORNER_RADIUS = 4;

/** Total drawing width for `capacity` bays laid out in a row. */
export function workshopWidth(capacity: number): number {
  return capacity * BAY_WIDTH + Math.max(capacity - 1, 0) * BAY_GAP;
}

export function bayX(index: number): number {
  return index * (BAY_WIDTH + BAY_GAP);
}
