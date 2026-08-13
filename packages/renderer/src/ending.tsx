import type { VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import { ENDING_HEIGHT, ENDING_LINE_HEIGHT, ENDING_WIDTH } from './geometry.js';
import { Printer } from './printer.js';

/**
 * The ending (spec §6 phase 6): "numbers fade to ∞ → museum shot of printer #1
 * → credits print out".
 *
 * Three stages, and the renderer draws whichever one the projection says it is
 * in. Nothing here counts: `stage`, `stageProgress` and `creditLines` are all
 * derived from the simulation clock, so a save reloaded mid-credits resumes on
 * the same line — the ending is state, not a script.
 */
export interface EndingProps {
  readonly visual: VisualState;
}

/** The numbers give up (spec §6). Whatever the ledger says, it now says ∞. */
function Numbers({ visual }: EndingProps): ReactElement {
  const { stageProgress } = visual.ending;
  return (
    <g data-testid="ending-numbers">
      <text className="ph-ending-title" x={ENDING_WIDTH / 2} y={ENDING_HEIGHT / 2 - 18}>
        {visual.ledger.money >= 1 ? '∞' : '0'}
      </text>
      <text
        className="ph-ending-line"
        x={ENDING_WIDTH / 2}
        y={ENDING_HEIGHT / 2 + 12}
        style={{ opacity: stageProgress }}
      >
        every number you had is now the same number
      </text>
    </g>
  );
}

/**
 * The museum shot: printer #1, under glass, at whatever tier the workshop
 * finished at. It is drawn with the same `Printer` component the workshop uses
 * — it is the same machine, which is the whole point of the shot.
 */
function Museum({ visual }: EndingProps): ReactElement {
  return (
    <g data-testid="ending-museum">
      <rect
        className="ph-museum-case"
        x={ENDING_WIDTH / 2 - 90}
        y={12}
        width={180}
        height={ENDING_HEIGHT - 60}
        rx={4}
      />
      <g transform={`translate(${ENDING_WIDTH / 2 - 80}, 18)`}>
        <Printer
          machineTier={visual.ending.museumTier}
          parts="all"
          running={false}
          progress={0}
          phaseOffset={0}
        />
      </g>
      <text className="ph-ending-line" x={ENDING_WIDTH / 2} y={ENDING_HEIGHT - 20}>
        {`printer #1 · ${visual.ending.museumPrinterId}`}
      </text>
    </g>
  );
}

/** The credits, printing out one line at a time (spec §6). */
function Credits({ visual }: EndingProps): ReactElement {
  const lines = visual.ending.credits.slice(0, visual.ending.creditLines);
  return (
    <g data-testid="ending-credits" data-lines={visual.ending.creditLines}>
      {lines.map((line, index) => (
        <text
          // Credit lines repeat (blank spacers), so the index is the identity.
          key={`${index}-${line}`}
          className="ph-ending-line"
          x={ENDING_WIDTH / 2}
          y={ENDING_HEIGHT - (lines.length - index) * ENDING_LINE_HEIGHT}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

export function Ending({ visual }: EndingProps): ReactElement | null {
  const { stage } = visual.ending;
  if (stage === 'none') {
    return null;
  }
  return (
    <svg
      className="printhead-ending"
      role="img"
      aria-label={`PRINTHEAD — the ending, ${stage}`}
      data-testid="ending"
      data-stage={stage}
      viewBox={`0 0 ${ENDING_WIDTH} ${ENDING_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{`PRINTHEAD — ${stage}`}</title>
      {stage === 'numbers' ? <Numbers visual={visual} /> : null}
      {stage === 'museum' ? <Museum visual={visual} /> : null}
      {stage === 'credits' || stage === 'complete' ? <Credits visual={visual} /> : null}
    </svg>
  );
}
