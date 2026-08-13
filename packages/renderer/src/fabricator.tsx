import type { VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import {
  FABRICATOR_BAND_GAP,
  FABRICATOR_HEIGHT,
  FABRICATOR_PAD,
  FABRICATOR_WIDTH,
} from './geometry.js';

/**
 * The Universal Fabricator (spec §6 phase 6) — **the one synced render**.
 *
 * Everything else in the workshop is decorative: an idle sweep, a progress bar,
 * a badge. This is the one drawing that is *the* simulation, layer by layer.
 * The projection carries `layer` and `layers`, both derived from the run's own
 * clock, so the renderer needs no timer of its own and two viewers of the same
 * save are looking at the same layer of the same object.
 *
 * The bands are drawn from the bottom up: `layer` of them are solid, the one
 * above is the layer being laid down right now, and the rest are the outline of
 * what is still to come.
 */
export interface FabricatorProps {
  readonly visual: VisualState;
}

/**
 * How many bands the drawing uses. The build may be a hundred and forty layers
 * deep; a band per layer would be a grey smear, so the drawing has its own
 * resolution and maps the layer count onto it.
 */
const BANDS = 28;

function bandCount(layer: number, layers: number): number {
  if (layers <= 0) {
    return 0;
  }
  return Math.min(Math.round((layer / layers) * BANDS), BANDS);
}

export function Fabricator({ visual }: FabricatorProps): ReactElement | null {
  const { fabricator } = visual;
  if (!fabricator.running && !fabricator.complete) {
    return null;
  }
  const filled = bandCount(fabricator.layer, fabricator.layers);
  const bandHeight = (FABRICATOR_HEIGHT - FABRICATOR_PAD * 2) / BANDS;
  const bands = Array.from({ length: BANDS }, (_unused, index) => index);
  return (
    <g
      data-testid="fabricator"
      data-layer={fabricator.layer}
      data-layers={fabricator.layers}
      data-complete={fabricator.complete}
      className={fabricator.complete ? 'ph-fabricator ph-fabricator--complete' : 'ph-fabricator'}
    >
      <title>{`Universal Fabricator — layer ${fabricator.layer} of ${fabricator.layers}`}</title>
      <rect
        className="ph-fabricator-bed"
        x={0}
        y={FABRICATOR_HEIGHT - FABRICATOR_PAD}
        width={FABRICATOR_WIDTH}
        height={FABRICATOR_PAD}
      />
      {bands.map((index) => {
        // Band 0 is the bottom of the build, so the object grows upwards.
        const y = FABRICATOR_HEIGHT - FABRICATOR_PAD - (index + 1) * bandHeight;
        // A taper, so the thing being printed reads as an object rather than a
        // progress bar wearing a hat.
        const inset = (index / BANDS) * FABRICATOR_WIDTH * 0.18;
        const state = index < filled ? 'done' : index === filled ? 'printing' : 'pending';
        return (
          <rect
            key={index}
            className={`ph-fabricator-band ph-fabricator-band--${state}`}
            data-band={state}
            x={FABRICATOR_PAD + inset}
            y={y}
            width={FABRICATOR_WIDTH - (FABRICATOR_PAD + inset) * 2}
            height={Math.max(bandHeight - FABRICATOR_BAND_GAP, 1)}
          />
        );
      })}
    </g>
  );
}
