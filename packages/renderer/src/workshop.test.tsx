import { VISUAL_STATE_VERSION, type VisualState } from '@printhead/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Workshop } from './workshop.js';

const empty: VisualState = {
  version: VISUAL_STATE_VERSION,
  phaseId: 'intro',
  simTimeMs: 0,
  slots: [],
};

const withSlots: VisualState = {
  ...empty,
  phaseId: 'farm',
  slots: [
    {
      slotId: 'slot-1',
      materialId: 'pla',
      objectId: 'bracket',
      machineTier: 1,
      printerCount: 7,
      phaseOffset: 0,
    },
    {
      slotId: 'slot-2',
      materialId: 'petg',
      objectId: 'gearset',
      machineTier: 2,
      printerCount: 1,
      phaseOffset: 0.5,
    },
  ],
};

afterEach(cleanup);

describe('Workshop', () => {
  it('renders every VisualState fixture', () => {
    for (const fixture of [empty, withSlots]) {
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

  it('shows an empty workshop before the first printer exists', () => {
    render(<Workshop visual={empty} />);
    expect(screen.getByTestId('empty-workshop')).toBeDefined();
  });

  it('is a pure function of VisualState — same input, same markup', () => {
    const first = render(<Workshop visual={withSlots} />).container.innerHTML;
    cleanup();
    const second = render(<Workshop visual={withSlots} />).container.innerHTML;
    expect(second).toBe(first);
  });
});
