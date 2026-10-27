import type { ReactElement } from 'react';
import { FLOOR_WIDTH } from './geometry.js';

/**
 * The workshop's back wall, which fills up as the print does. Each layer hangs
 * one more thing — a spool shelf, a blueprint, the plates, a neon sign,
 * fairy lights — so a glance at the room says how far the game has come,
 * without a word or a number. Art, not rules: the ids below only pick
 * decorations, and the wall starts bare.
 */
const WALL_ORDER = ['intro', 'bench', 'farm', 'studio', 'prestige', 'absurd', 'end', 'ended'];

/** How tall the wall band is, in floor units. */
export const WALL_HEIGHT = 120;

function stage(phaseId: string): number {
  return Math.max(WALL_ORDER.indexOf(phaseId), 0);
}

const SPOOL_COLOURS = ['#E23673', '#1FA595', '#F5A23A', '#9AA6B2'];

function SpoolShelf(): ReactElement {
  return (
    <g data-wall="shelf" className="ph-wall-item">
      <rect x={200} y={70} width={150} height={6} rx={2} className="ph-wall-shelf" />
      {SPOOL_COLOURS.map((colour, index) => (
        <g key={colour} transform={`translate(${218 + index * 36}, 52)`}>
          <circle r={15} className="ph-wall-spool-rim" />
          <circle r={11} fill={colour} />
          <circle r={4} className="ph-wall-spool-hub" />
        </g>
      ))}
    </g>
  );
}

function Clock(): ReactElement {
  return (
    <g data-wall="clock" className="ph-wall-item" transform={`translate(${FLOOR_WIDTH - 190}, 40)`}>
      <circle r={16} className="ph-wall-clock" />
      <path d="M0 0v-10M0 0l7 4" className="ph-wall-hand" />
    </g>
  );
}

function Blueprint(): ReactElement {
  return (
    <g data-wall="blueprint" className="ph-wall-item">
      <rect x={378} y={16} width={70} height={52} rx={3} className="ph-wall-blueprint" />
      <path d="M390 56l14-26 14 26M398 44h12M430 26v30" className="ph-wall-blueprint-ink" />
    </g>
  );
}

function Plates(): ReactElement {
  return (
    <g data-wall="plates" className="ph-wall-item">
      {[0, 1, 2].map((index) => (
        <g key={index} transform={`translate(${462 + index * 20}, ${22 + index * 3})`}>
          <path d="M8 -6v6" className="ph-wall-hand" />
          <rect width={16} height={22} rx={2} className="ph-wall-plate" />
        </g>
      ))}
    </g>
  );
}

function Neon(): ReactElement {
  return (
    <g data-wall="neon" className="ph-wall-item">
      <text x={FLOOR_WIDTH / 2} y={108} textAnchor="middle" className="ph-wall-neon">
        PRINTHEAD
      </text>
    </g>
  );
}

function Lights(): ReactElement {
  const bulbs = 18;
  return (
    <g data-wall="lights" className="ph-wall-item">
      <path
        d={`M0 8 Q ${FLOOR_WIDTH / 4} 26 ${FLOOR_WIDTH / 2} 8 T ${FLOOR_WIDTH} 8`}
        className="ph-wall-wire"
      />
      {Array.from({ length: bulbs }, (_unused, index) => {
        const x = ((index + 0.5) / bulbs) * FLOOR_WIDTH;
        const phase = (x / (FLOOR_WIDTH / 2)) * Math.PI;
        return (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: bulbs on a string have no identity
            key={index}
            cx={x}
            cy={8 + Math.abs(Math.sin(phase)) * 16}
            r={3.2}
            className="ph-wall-bulb"
            style={{ animationDelay: `${(index % 5) * 0.3}s` }}
          />
        );
      })}
    </g>
  );
}

export function WorkshopWall({ phaseId }: { phaseId: string }): ReactElement {
  const reached = stage(phaseId);
  return (
    <g data-testid="workshop-wall" data-wall-stage={reached}>
      <rect x={0} y={0} width={FLOOR_WIDTH} height={WALL_HEIGHT} className="ph-wall" />
      <path d={`M0 ${WALL_HEIGHT}H${FLOOR_WIDTH}`} className="ph-wall-skirting" />
      {reached >= stage('farm') ? <SpoolShelf /> : null}
      {reached >= stage('farm') ? <Clock /> : null}
      {reached >= stage('studio') ? <Blueprint /> : null}
      {reached >= stage('prestige') ? <Plates /> : null}
      {reached >= stage('absurd') ? <Neon /> : null}
      {reached >= stage('end') ? <Lights /> : null}
    </g>
  );
}
