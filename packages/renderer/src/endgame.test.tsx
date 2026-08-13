import { visualFixture } from '@printhead/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Ending } from './ending.js';
import { Workshop } from './workshop.js';

afterEach(cleanup);

/**
 * The endgame drawings (spec §5E, §6 phase 6). Every case renders a *shipped
 * fixture* — a document the simulation actually produced — so a drawing proved
 * here is a drawing the game can reach.
 */
describe('the printed city (spec §5E)', () => {
  it('appears behind the rack once the building is printed', () => {
    render(<Workshop visual={visualFixture('endgame')} />);
    const backdrop = screen.getByTestId('backdrop');
    expect(backdrop.getAttribute('data-backdrop')).toBe('skyline');
    expect(backdrop.querySelectorAll('.ph-backdrop-tower').length).toBeGreaterThan(0);
  });

  it('is absent while the workshop is still a workshop', () => {
    render(<Workshop visual={visualFixture('economy')} />);
    expect(screen.queryByTestId('backdrop')).toBeNull();
  });
});

describe('the Universal Fabricator — the one synced render (spec §6)', () => {
  it('draws the build layer by layer, straight off the projection', () => {
    const visual = visualFixture('fabricator');
    render(<Workshop visual={visual} />);
    const build = screen.getByTestId('fabricator');
    expect(build.getAttribute('data-layer')).toBe(String(visual.fabricator.layer));
    expect(build.getAttribute('data-layers')).toBe(String(visual.fabricator.layers));
    // Some bands are laid down, some are still outlines: the drawing is a
    // *position* in the build, not a progress bar.
    expect(build.querySelectorAll('[data-band="done"]').length).toBeGreaterThan(0);
    expect(build.querySelectorAll('[data-band="pending"]').length).toBeGreaterThan(0);
    expect(build.querySelectorAll('[data-band="printing"]')).toHaveLength(1);
  });

  it('takes the whole frame: the rack is not drawn under it (spec §4)', () => {
    render(<Workshop visual={visualFixture('fabricator')} />);
    expect(screen.getByRole('img').getAttribute('data-layout')).toBe('fabricator');
    expect(screen.queryByTestId('slot-slot-1')).toBeNull();
  });

  it('is not drawn at all before the last print starts', () => {
    render(<Workshop visual={visualFixture('endgame')} />);
    expect(screen.queryByTestId('fabricator')).toBeNull();
  });
});

describe('the ending (spec §6 phase 6)', () => {
  it('prints the credits out one line at a time', () => {
    const visual = visualFixture('ending');
    expect(visual.ending.stage).toBe('credits');
    render(<Ending visual={visual} />);
    const credits = screen.getByTestId('ending-credits');
    expect(credits.querySelectorAll('text').length).toBe(visual.ending.creditLines);
    expect(visual.ending.creditLines).toBeLessThanOrEqual(visual.ending.credits.length);
  });

  it('shows nothing at all before the last print lands', () => {
    render(<Ending visual={visualFixture('endgame')} />);
    expect(screen.queryByTestId('ending')).toBeNull();
  });

  /**
   * The three stages are the projection's, not the renderer's: the same
   * component draws whichever one it is handed, and it counts nothing itself.
   */
  it('draws the numbers and the museum shot when the stage says so', () => {
    const credits = visualFixture('ending');
    const numbers = { ...credits, ending: { ...credits.ending, stage: 'numbers' as const } };
    const museum = { ...credits, ending: { ...credits.ending, stage: 'museum' as const } };
    const { unmount } = render(<Ending visual={numbers} />);
    expect(screen.getByTestId('ending-numbers')).toBeTruthy();
    unmount();

    render(<Ending visual={museum} />);
    expect(screen.getByTestId('ending-museum')).toBeTruthy();
    // The museum shot is printer #1 itself, drawn by the same component the
    // workshop uses — it is the same machine.
    expect(screen.getByTestId('printer-figure')).toBeTruthy();
  });
});
