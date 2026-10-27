import type { CSSProperties, ReactElement } from 'react';
import type { CharacterKind, FaceId } from './character-kit.js';
import { Character } from './character.js';
import { BASE_X, BASE_Y, BAY_WIDTH, CHARACTER_SIZE, CHARACTER_Y } from './geometry.js';
import { machineTierStyle } from './machine-tier.js';

/**
 * The printer in a bay (spec §10: "SVG-in-JSX ideal for the vector printer").
 *
 * Since the M7 redesign it is a *character* from the Printhead cast: Mk1, Mk2
 * or Mk3 by machine tier, Amber for resin, Goliath for the fork, each with an
 * LCD face. It is built from the *same seven pieces the intro assembles*
 * (spec §6 phase 0), so one component serves both: during the intro only the
 * attached pieces are drawn, and the controller — the face — goes on last.
 *
 * Everything it knows comes from its props, which come from `VisualState`
 * (plus the short-lived face reactions the shell derives from events). It has
 * no state, no clock and no content lookups.
 */

/**
 * Drawing order matters (later pieces sit on top). These ids match the assembly
 * pieces in `content/start.json`; an id the renderer does not recognise is drawn
 * as a generic crate so a content rename degrades instead of vanishing.
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
 * **Products**, not Parts (spec §5D).
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
  /** Which member of the cast; defaults to the machine tier's printer. */
  readonly kind?: CharacterKind;
  /** The LCD expression; defaults to focus while printing, idle otherwise. */
  readonly face?: FaceId;
  readonly overclocked?: boolean;
}

const UNKNOWN_PART_SIZE = 14;
const ARTWORK = 200;

function isKnownPart(id: string): id is PrinterPartId {
  return (PRINTER_PART_IDS as readonly string[]).includes(id);
}

function tierKind(tier: number): CharacterKind {
  if (tier >= 3) {
    return 'mk3';
  }
  return tier === 2 ? 'mk2' : 'mk1';
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
  kind,
  face,
  overclocked = false,
}: PrinterProps): ReactElement {
  const style = machineTierStyle(machineTier);
  const assembling = parts !== 'all';
  const visible = assembling ? new Set(parts) : new Set<string>(PRINTER_PART_IDS);
  const extras = [...visible].filter((id) => !isKnownPart(id));
  const resolvedKind = assembling ? 'mk1' : (kind ?? tierKind(style.tier));
  const resolvedFace: FaceId =
    face ?? (assembling && visible.has('controller') ? 'wow' : running ? 'focus' : 'idle');
  const scale = CHARACTER_SIZE / ARTWORK;
  const cssVars = { '--ph-offset': phaseOffset } as CSSProperties;

  return (
    <g
      data-testid="printer-figure"
      data-machine-tier={style.tier}
      data-frame={style.frame}
      data-nozzle={style.nozzle}
      data-bed={style.bed}
      data-output={output}
      className={[
        'printer',
        `printer--tier-${style.tier}`,
        `printer--frame-${style.frame}`,
        running ? 'printer--running' : 'printer--idle',
      ].join(' ')}
      style={cssVars}
    >
      <title>{style.label}</title>
      <g
        transform={`translate(${(BAY_WIDTH - CHARACTER_SIZE) / 2}, ${CHARACTER_Y}) scale(${scale})`}
      >
        <Character
          kind={resolvedKind}
          face={resolvedFace}
          progress={progress}
          {...(assembling ? { parts: [...visible].filter(isKnownPart) } : {})}
          printing={running}
          overclocked={overclocked}
          phaseOffset={phaseOffset}
          output={output}
        />
      </g>
      {extras.map((id, index) => (
        <UnknownPart key={id} id={id} index={index} />
      ))}
    </g>
  );
}
