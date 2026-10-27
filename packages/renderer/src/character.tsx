import type { SlotVisual } from '@printhead/core';
import type { CSSProperties, ReactElement } from 'react';
import {
  BLINK_GRID,
  type CharacterKind,
  FACE_GRIDS,
  FRONT_SHAPES,
  type FaceId,
  type Shape,
  drawCharacter,
  facePath,
} from './character-kit.js';

/**
 * One printer character (Printhead design system: Cast). Pure: everything it
 * draws comes from its props. The idle blink, the toolhead sweep and the
 * overclock shimmer are CSS, desynchronised by `phaseOffset` exactly as the
 * old machine drawing was, so no clock is needed.
 */
export interface CharacterProps {
  readonly kind: CharacterKind;
  readonly face: FaceId;
  /** 0..1 — how tall the current print has grown. */
  readonly progress: number;
  /** Assembly pieces attached so far (Mk1 only); omitted once it is built. */
  readonly parts?: readonly string[];
  readonly printing: boolean;
  readonly overclocked?: boolean;
  readonly phaseOffset: number;
  readonly output?: 'parts' | 'products';
}

function ShapeEl({ shape }: { shape: Shape }): ReactElement {
  const Tag = shape.tag;
  return (
    <Tag
      className={shape.className}
      {...shape.attrs}
      {...(shape.part === undefined ? {} : { 'data-part': shape.part })}
      {...(shape.print === undefined
        ? {}
        : { 'data-testid': 'print-in-progress', 'data-output': shape.print })}
    />
  );
}

const shapeKey = (shape: Shape, index: number): string => `${shape.tag}-${index}`;

export function Character({
  kind,
  face,
  progress,
  parts,
  printing,
  overclocked = false,
  phaseOffset,
  output = 'parts',
}: CharacterProps): ReactElement {
  const drawing = drawCharacter(kind, {
    face,
    output,
    progress,
    parts: parts === undefined ? 'all' : new Set(parts),
  });
  const front = FRONT_SHAPES[kind] ?? [];
  const screen = drawing.screen;
  const style = { '--pc-offset': phaseOffset } as CSSProperties;
  return (
    <g
      data-testid="character"
      data-kind={kind}
      data-face={face}
      className={[
        'pc-char',
        `pc-${kind}`,
        printing ? 'is-printing' : '',
        overclocked ? 'is-overclocked' : '',
      ]
        .filter((part) => part.length > 0)
        .join(' ')}
      style={style}
    >
      {drawing.shapes.map((shape, index) => (
        <ShapeEl key={shapeKey(shape, index)} shape={shape} />
      ))}
      <g className="pc-carriage">
        {drawing.carriage.map((shape, index) => (
          <ShapeEl key={shapeKey(shape, index)} shape={shape} />
        ))}
      </g>
      {front.map((shape, index) => (
        <ShapeEl key={shapeKey(shape, index)} shape={shape} />
      ))}
      {screen === null ? null : (
        <g data-testid="lcd" data-face={face}>
          <rect
            className="pc-o pc-screen"
            x={screen.x}
            y={screen.y}
            width={screen.w}
            height={screen.h}
            rx={Math.min(6, screen.h / 4)}
          />
          <svg x={screen.x} y={screen.y} width={screen.w} height={screen.h} viewBox="0 0 60 26">
            <title>{`${face} face`}</title>
            <path
              className={face === 'idle' ? 'pc-pixel pc-eyes-open' : 'pc-pixel'}
              d={facePath(FACE_GRIDS[face])}
            />
            {face === 'idle' ? (
              <path className="pc-pixel pc-eyes-blink" d={facePath(BLINK_GRID)} />
            ) : null}
          </svg>
          <path
            className="pc-glare"
            d={`M${screen.x + screen.w - 14} ${screen.y + 4}l6 0 -8 ${screen.h - 8} -6 0z`}
          />
        </g>
      )}
    </g>
  );
}

/** Which character a bay draws: its machine tier, unless resin makes it Amber. */
export function kindFor(slot: SlotVisual, goliath: boolean): CharacterKind {
  if (goliath) {
    return 'goliath';
  }
  if (slot.materialId === 'resin') {
    return 'amber';
  }
  if (slot.machineTier >= 3) {
    return 'mk3';
  }
  return slot.machineTier === 2 ? 'mk2' : 'mk1';
}

/** How close the failure meter has to be before the face shows it coming. */
const WORRY_AT = 0.6;
/** How full the perfect meter has to be before the face lights up for it. */
const EAGER_AT = 0.9;

/**
 * The face a bay wears (design system: Faces). `flourish` is a short-lived
 * reaction the shell derives from domain events — a Perfect print, a failure —
 * and outranks the resting expression while it lasts.
 */
export function faceFor(slot: SlotVisual, flourish?: FaceId): FaceId {
  if (flourish !== undefined) {
    return flourish;
  }
  if (!slot.occupied) {
    return slot.printerCount > 0 ? 'idle' : 'off';
  }
  if (slot.running && slot.failureRisk >= WORRY_AT) {
    return 'worried';
  }
  if (slot.overclock.active) {
    return 'wow';
  }
  if (slot.running && slot.perfectCharge >= EAGER_AT) {
    return 'happy';
  }
  return slot.running ? 'focus' : 'idle';
}
