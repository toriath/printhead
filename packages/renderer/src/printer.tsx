import type { CSSProperties, ReactElement } from 'react';
import {
  BASE_HEIGHT,
  BASE_WIDTH,
  BASE_X,
  BASE_Y,
  BED_HEIGHT,
  BED_WIDTH,
  BED_X,
  BED_Y,
  CARRIAGE_HEIGHT,
  CARRIAGE_HOME_X,
  CARRIAGE_TRAVEL,
  CARRIAGE_WIDTH,
  CONTROLLER_HEIGHT,
  CONTROLLER_WIDTH,
  CONTROLLER_X,
  CONTROLLER_Y,
  CORNER_RADIUS,
  FRAME_HEIGHT,
  FRAME_UPRIGHT,
  FRAME_WIDTH,
  FRAME_X,
  FRAME_Y,
  GANTRY_HEIGHT,
  GANTRY_INSET,
  GANTRY_Y,
  NOZZLE_HEIGHT,
  NOZZLE_WIDTH,
  PRINT_MAX_HEIGHT,
  PRINT_WIDTH,
  SPOOL_CX,
  SPOOL_CY,
  SPOOL_HUB_R,
  SPOOL_R,
} from './geometry.js';
import { machineTierStyle } from './machine-tier.js';

/**
 * The vector printer (spec §10: "SVG-in-JSX ideal for the vector printer").
 *
 * It is built from the *same seven parts the intro assembles* (spec §6 phase 0)
 * so one component serves both: during the intro only the attached parts are
 * drawn, and each click makes the next one appear on the machine that will keep
 * printing for the rest of the game.
 *
 * Everything it knows comes from its props, which come from `VisualState`. It
 * has no state, no clock and no content lookups — the idle animation is CSS
 * driven by `phaseOffset` (see `styles.ts`).
 */

/**
 * Drawing order matters (later parts sit on top). These ids match the assembly
 * pieces in `content/start.json`; an id the renderer does not recognise falls
 * back to a generic crate so a content rename degrades instead of vanishing.
 */
export const PRINTER_PART_IDS = [
  'frame',
  'gantry',
  'bed',
  'extruder',
  'hotend',
  'spool-holder',
  'controller',
] as const;

export type PrinterPartId = (typeof PRINTER_PART_IDS)[number];

/**
 * What is growing on the bed. A bay printing one of the player's Designs makes
 * **Products**, not Parts (spec §5D), and the object is drawn differently so
 * the studio bay reads as the studio bay at a glance.
 */
export type PrintOutput = 'parts' | 'products';

export interface PrinterProps {
  readonly machineTier: number;
  /** Which assembly pieces to draw; `'all'` for a finished machine. */
  readonly parts: readonly string[] | 'all';
  readonly running: boolean;
  /** 0..1 — desynchronises the idle sweep between identical printers. */
  readonly phaseOffset: number;
  /** 0..1 — how tall the object currently on the bed has grown. */
  readonly progress: number;
  /** Parts, or a Product from one of the player's Designs (spec §5D). */
  readonly output?: PrintOutput;
}

const UNKNOWN_PART_SIZE = 14;

function isKnownPart(id: string): id is PrinterPartId {
  return (PRINTER_PART_IDS as readonly string[]).includes(id);
}

function Frame({ strut }: { strut: number }): ReactElement {
  return (
    <g data-part="frame">
      <rect
        className="ph-frame"
        x={FRAME_X}
        y={FRAME_Y}
        width={FRAME_WIDTH}
        height={FRAME_HEIGHT}
        rx={CORNER_RADIUS}
        strokeWidth={strut}
      />
      <rect
        className="ph-strut"
        x={FRAME_X}
        y={FRAME_Y}
        width={FRAME_UPRIGHT * strut}
        height={FRAME_HEIGHT}
      />
      <rect
        className="ph-strut"
        x={FRAME_X + FRAME_WIDTH - FRAME_UPRIGHT * strut}
        y={FRAME_Y}
        width={FRAME_UPRIGHT * strut}
        height={FRAME_HEIGHT}
      />
      <rect
        className="ph-base"
        x={BASE_X}
        y={BASE_Y}
        width={BASE_WIDTH}
        height={BASE_HEIGHT}
        rx={CORNER_RADIUS / 2}
      />
    </g>
  );
}

function Gantry(): ReactElement {
  return (
    <rect
      data-part="gantry"
      className="ph-strut"
      x={FRAME_X + GANTRY_INSET}
      y={GANTRY_Y}
      width={FRAME_WIDTH - GANTRY_INSET * 2}
      height={GANTRY_HEIGHT}
      rx={GANTRY_HEIGHT / 2}
    />
  );
}

function Bed({
  bed,
  progress,
  output,
}: { bed: string; progress: number; output: PrintOutput }): ReactElement {
  const printHeight = PRINT_MAX_HEIGHT * Math.min(Math.max(progress, 0), 1);
  return (
    <g data-part="bed">
      {bed === 'heated' ? (
        <rect
          className="ph-bed-heat"
          x={BED_X - 4}
          y={BED_Y - 2}
          width={BED_WIDTH + 8}
          height={BED_HEIGHT + 6}
          rx={CORNER_RADIUS}
        />
      ) : null}
      <rect className="ph-bed" x={BED_X} y={BED_Y} width={BED_WIDTH} height={BED_HEIGHT} rx={1} />
      {bed === 'auto-level' ? (
        <circle className="ph-bed-probe" cx={BED_X + BED_WIDTH - 6} cy={BED_Y - 3} r={2.5} />
      ) : null}
      {printHeight > 0 ? (
        <rect
          data-testid="print-in-progress"
          data-output={output}
          className={output === 'products' ? 'ph-print ph-print--product' : 'ph-print'}
          x={BED_X + (BED_WIDTH - PRINT_WIDTH) / 2}
          y={BED_Y - printHeight}
          width={PRINT_WIDTH}
          height={printHeight}
        />
      ) : null}
    </g>
  );
}

function Carriage({ withNozzle }: { withNozzle: boolean }): ReactElement {
  const nozzleTop = CARRIAGE_HEIGHT;
  const centre = CARRIAGE_WIDTH / 2;
  // The sweep lives on the inner group: a CSS `transform` animation *replaces*
  // the SVG `transform` attribute, so parking the carriage on the gantry has to
  // happen on a parent the animation never touches.
  return (
    <g transform={`translate(${CARRIAGE_HOME_X}, 0)`}>
      <g className="ph-carriage" data-part="extruder">
        <rect
          className="ph-carriage-body"
          x={0}
          y={GANTRY_Y - CARRIAGE_HEIGHT / 3}
          width={CARRIAGE_WIDTH}
          height={CARRIAGE_HEIGHT}
          rx={2}
        />
        {withNozzle ? (
          <g data-part="hotend" transform={`translate(0, ${GANTRY_Y - CARRIAGE_HEIGHT / 3})`}>
            <circle className="ph-nozzle-glow" cx={centre} cy={nozzleTop + NOZZLE_HEIGHT} r={7} />
            <polygon
              className="ph-nozzle"
              points={`${centre - NOZZLE_WIDTH / 2},${nozzleTop} ${centre + NOZZLE_WIDTH / 2},${nozzleTop} ${centre},${nozzleTop + NOZZLE_HEIGHT}`}
            />
          </g>
        ) : null}
      </g>
    </g>
  );
}

function Spool(): ReactElement {
  return (
    <g data-part="spool-holder">
      <g className="ph-spool">
        <circle className="ph-spool-rim" cx={SPOOL_CX} cy={SPOOL_CY} r={SPOOL_R} />
        <circle className="ph-spool-hub" cx={SPOOL_CX} cy={SPOOL_CY} r={SPOOL_HUB_R} />
      </g>
      <path
        className="ph-filament"
        d={`M ${SPOOL_CX + SPOOL_R} ${SPOOL_CY} Q ${FRAME_X + FRAME_WIDTH / 2} ${SPOOL_CY} ${CARRIAGE_HOME_X + CARRIAGE_WIDTH / 2} ${GANTRY_Y}`}
      />
    </g>
  );
}

function Controller(): ReactElement {
  return (
    <g data-part="controller">
      <rect
        className="ph-controller"
        x={CONTROLLER_X}
        y={CONTROLLER_Y}
        width={CONTROLLER_WIDTH}
        height={CONTROLLER_HEIGHT}
        rx={2}
      />
      <rect
        className="ph-controller-screen"
        x={CONTROLLER_X + 4}
        y={CONTROLLER_Y + 4}
        width={CONTROLLER_WIDTH - 8}
        height={CONTROLLER_HEIGHT - 8}
      />
    </g>
  );
}

function UnknownPart({ id, index }: { id: string; index: number }): ReactElement {
  return (
    <rect
      data-part={id}
      data-unknown-part="true"
      className="ph-strut"
      x={BASE_X + index * (UNKNOWN_PART_SIZE + 2)}
      y={BASE_Y - UNKNOWN_PART_SIZE}
      width={UNKNOWN_PART_SIZE}
      height={UNKNOWN_PART_SIZE}
    />
  );
}

export function Printer({
  machineTier,
  parts,
  running,
  phaseOffset,
  progress,
  output = 'parts',
}: PrinterProps): ReactElement {
  const style = machineTierStyle(machineTier);
  const visible = parts === 'all' ? new Set<string>(PRINTER_PART_IDS) : new Set(parts);
  const has = (id: PrinterPartId): boolean => visible.has(id);
  const extras = [...visible].filter((id) => !isKnownPart(id));
  const cssVars = {
    '--ph-offset': phaseOffset,
    '--ph-travel': `${CARRIAGE_TRAVEL}px`,
  } as CSSProperties;

  return (
    <g
      data-testid="printer-figure"
      data-machine-tier={style.tier}
      data-frame={style.frame}
      data-nozzle={style.nozzle}
      data-bed={style.bed}
      className={[
        'printer',
        `printer--tier-${style.tier}`,
        `printer--frame-${style.frame}`,
        `printer--nozzle-${style.nozzle}`,
        `printer--bed-${style.bed}`,
        running ? 'printer--running' : 'printer--idle',
      ].join(' ')}
      style={cssVars}
    >
      <title>{style.label}</title>
      {has('frame') ? <Frame strut={style.strutScale} /> : null}
      {has('frame') && style.enclosure ? (
        <rect
          data-part="enclosure"
          className="ph-enclosure"
          x={FRAME_X - 4}
          y={FRAME_Y - 4}
          width={FRAME_WIDTH + 8}
          height={FRAME_HEIGHT + 8}
          rx={CORNER_RADIUS}
        />
      ) : null}
      {has('gantry') ? <Gantry /> : null}
      {has('bed') ? <Bed bed={style.bed} progress={progress} output={output} /> : null}
      {has('extruder') ? <Carriage withNozzle={has('hotend')} /> : null}
      {has('spool-holder') ? <Spool /> : null}
      {has('controller') ? <Controller /> : null}
      {extras.map((id, index) => (
        <UnknownPart key={id} id={id} index={index} />
      ))}
    </g>
  );
}
