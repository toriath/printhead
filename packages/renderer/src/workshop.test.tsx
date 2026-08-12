import {
  type AssemblyVisual,
  type LedgerVisual,
  VISUAL_STATE_VERSION,
  type VisualState,
} from '@printhead/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Workshop } from './workshop.js';

const ledger: LedgerVisual = { parts: 0, money: 0, scrap: 0, filamentGrams: { pla: 40 } };

const assembly: AssemblyVisual = {
  attachedPieceIds: [],
  totalPieces: 7,
  nextPieceId: 'frame',
  nextPieceName: 'Frame',
  cooldownMs: 34_000,
  complete: false,
};

/** A fresh save: nothing built, nothing printing. */
const empty: VisualState = {
  version: VISUAL_STATE_VERSION,
  phaseId: 'intro',
  simTimeMs: 0,
  slots: [],
  assembly,
  ledger,
};

/** Mid-intro: three pieces on the bench, still no printer. */
const assembling: VisualState = {
  ...empty,
  assembly: {
    ...assembly,
    attachedPieceIds: ['frame', 'gantry', 'bed'],
    nextPieceId: 'extruder',
    nextPieceName: 'Extruder',
  },
};

const withSlots: VisualState = {
  ...empty,
  phaseId: 'farm',
  assembly: { ...assembly, attachedPieceIds: [], complete: true, nextPieceId: null },
  ledger: { ...ledger, parts: 12, money: 30 },
  slots: [
    {
      slotId: 'slot-1',
      materialId: 'pla',
      objectId: 'bracket',
      machineTier: 1,
      printerCount: 7,
      phaseOffset: 0,
      running: true,
      progress: 0.5,
      batch: 7,
    },
    {
      slotId: 'slot-2',
      materialId: 'petg',
      objectId: 'gearset',
      machineTier: 2,
      printerCount: 1,
      phaseOffset: 0.5,
      running: false,
      progress: 0,
      batch: 0,
    },
  ],
};

afterEach(cleanup);

describe('Workshop', () => {
  it('renders every VisualState fixture', () => {
    for (const fixture of [empty, assembling, withSlots]) {
      cleanup();
      render(<Workshop visual={fixture} />);
      expect(screen.getByRole('img')).toHaveProperty('dataset.phase', fixture.phaseId);
    }
  });

  it('renders one visual per slot, not per printer (spec §4)', () => {
    render(<Workshop visual={withSlots} />);
    expect(screen.getAllByTestId(/^printer-/)).toHaveLength(2);
    expect(screen.getByTestId('printer-slot-1').textContent).toContain('×7');
  });

  it('shows the intro assembly, piece by piece, before the first printer exists', () => {
    render(<Workshop visual={assembling} />);
    expect(screen.getByTestId('assembly-progress').textContent).toBe('3/7 pieces');
    expect(screen.getAllByTestId(/^piece-/)).toHaveLength(3);
  });

  it('draws a progress bar scaled to the run', () => {
    render(<Workshop visual={withSlots} />);
    expect(screen.getByTestId('progress-slot-1').getAttribute('width')).toBe('60');
    expect(screen.getByTestId('progress-slot-2').getAttribute('width')).toBe('0');
  });

  it('is a pure function of VisualState — same input, same markup', () => {
    const first = render(<Workshop visual={withSlots} />).container.innerHTML;
    cleanup();
    const second = render(<Workshop visual={withSlots} />).container.innerHTML;
    expect(second).toBe(first);
  });
});
