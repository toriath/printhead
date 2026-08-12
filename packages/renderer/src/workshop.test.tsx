import { type VisualState, visualFixture, visualStateFixtures } from '@printhead/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BAY_HEIGHT, workshopWidth } from './geometry.js';
import { Workshop, bays } from './workshop.js';

afterEach(cleanup);

const fresh = visualFixture('fresh');
const assembling = visualFixture('assembling');
const printing = visualFixture('printing');
const showcase = visualFixture('showcase');

describe('Workshop', () => {
  it('renders every VisualState fixture (spec §13)', () => {
    for (const fixture of visualStateFixtures()) {
      cleanup();
      render(<Workshop visual={fixture.visual} />);
      const svg = screen.getByRole('img');
      expect(svg.getAttribute('data-phase'), fixture.describes).toBe(fixture.visual.phaseId);
      expect(svg.getAttribute('data-visual-version')).toBe(String(fixture.visual.version));
    }
  });

  it('is a pure function of VisualState — same input, same markup', () => {
    const first = render(<Workshop visual={showcase} />).container.innerHTML;
    cleanup();
    const second = render(<Workshop visual={showcase} />).container.innerHTML;
    expect(second).toBe(first);
  });

  it('draws the whole rack up to the hard slot cap (spec §4)', () => {
    render(<Workshop visual={fresh} />);
    expect(screen.getAllByTestId(/^bay-/)).toHaveLength(fresh.slotCapacity);
  });

  it('never draws more bays than the cap, even mid-intro', () => {
    expect(bays(assembling)).toHaveLength(assembling.slotCapacity);
  });

  it('sizes its viewBox from the rack it drew', () => {
    render(<Workshop visual={showcase} />);
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe(
      `0 0 ${workshopWidth(showcase.slotCapacity)} ${BAY_HEIGHT}`,
    );
  });

  it('grows the rack when a save owns more slots than the cap claims', () => {
    const overfull: VisualState = {
      ...showcase,
      slotCapacity: 2,
    };
    expect(bays(overfull)).toHaveLength(showcase.slots.length);
  });

  it('names the phase for screen readers from the projection, not a lookup', () => {
    render(<Workshop visual={printing} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      `PRINTHEAD workshop — ${printing.phaseName}`,
    );
  });
});

describe('slots (spec §4: once per slot, never once per printer)', () => {
  it('renders one machine per occupied slot with a count badge', () => {
    render(<Workshop visual={showcase} />);
    const occupied = showcase.slots.filter((slot) => slot.occupied);
    expect(screen.getAllByTestId('printer-figure')).toHaveLength(occupied.length);
    // slot-1 has seven printers; slot-3 has one and must NOT get a badge.
    expect(screen.getAllByTestId('count-badge')).toHaveLength(2);
    expect(screen.getByTestId('slot-slot-1').textContent).toContain('×7');
    expect(screen.getByTestId('slot-slot-3').textContent).not.toContain('×');
  });

  it('draws empty and locked bays as faint outlines', () => {
    render(<Workshop visual={showcase} />);
    const empty = screen.getByTestId('bay-slot-4');
    expect(empty.getAttribute('class')).toContain('ph-bay--empty');
    expect(screen.getByTestId('slot-slot-4').getAttribute('data-occupied')).toBe('false');
    expect(screen.getByTestId('label-slot-4').textContent).toBe('empty bay');
  });

  it('labels an occupied slot with its config', () => {
    render(<Workshop visual={showcase} />);
    expect(screen.getByTestId('label-slot-2').textContent).toBe('Gear set · PETG');
  });

  it('distinguishes "no printer" from "no config" from "empty"', () => {
    const mixed: VisualState = {
      ...showcase,
      slots: showcase.slots.map((slot) => {
        if (slot.slotId === 'slot-1') {
          return { ...slot, occupied: false, printerCount: 0 };
        }
        if (slot.slotId === 'slot-2') {
          return {
            ...slot,
            occupied: false,
            materialId: null,
            materialName: null,
            objectId: null,
            objectName: null,
          };
        }
        return slot;
      }),
    };
    render(<Workshop visual={mixed} />);
    expect(screen.getByTestId('label-slot-1').textContent).toBe('Bracket · PLA (no printer)');
    expect(screen.getByTestId('label-slot-2').textContent).toBe('no config loaded');
    expect(screen.getByTestId('label-slot-4').textContent).toBe('empty bay');
  });

  it('keeps a machine the player owns on screen while its bay is unconfigured', () => {
    render(<Workshop visual={visualFixture('assembled')} />);
    expect(screen.getAllByTestId('printer-figure')).toHaveLength(1);
    expect(screen.getByTestId('label-slot-1').textContent).toBe('no config loaded');
  });

  it('scales the progress bar to the run', () => {
    render(<Workshop visual={showcase} />);
    const widthOf = (slotId: string): number => {
      const fill = screen.getByTestId(`slot-${slotId}`).querySelector('.ph-progress-fill');
      return Number(fill?.getAttribute('width'));
    };
    const track = screen.getByTestId('slot-slot-1').querySelector('.ph-progress-track');
    const full = Number(track?.getAttribute('width'));
    expect(widthOf('slot-1')).toBeCloseTo(full * 0.5);
    expect(widthOf('slot-2')).toBeCloseTo(full * 0.125);
    // slot-3 is mid-purge: the bar tracks the changeover, not a print, because
    // the bay is busy either way and an empty bar would read as "idle".
    expect(widthOf('slot-3')).toBeCloseTo(full * 0.4);
    const purging = screen.getByTestId('slot-slot-3').querySelector('[data-purging="true"]');
    expect(purging).not.toBeNull();
  });

  it('draws the pity meter only where the charge has started building', () => {
    render(<Workshop visual={showcase} />);
    // Bays 1 and 2 carry charge; the purged bay was reset and the empty one
    // has no machine at all (spec §7.1).
    expect(
      screen.getByTestId('slot-slot-1').querySelector('[data-testid="risk-meter"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('slot-slot-3').querySelector('[data-testid="risk-meter"]'),
    ).toBeNull();
    expect(
      screen.getByTestId('slot-slot-4').querySelector('[data-testid="risk-meter"]'),
    ).toBeNull();
  });

  it('says what a purging bay is purging towards', () => {
    render(<Workshop visual={showcase} />);
    expect(screen.getByTestId('label-slot-3').textContent).toMatch(/^purging →/);
  });

  it('gives an empty bay no progress bar at all', () => {
    render(<Workshop visual={showcase} />);
    expect(screen.getByTestId('slot-slot-4').querySelector('.ph-progress-track')).toBeNull();
  });
});

describe('machine-tier visuals (spec §5A)', () => {
  it('gives every tier its own frame, nozzle and bed', () => {
    render(<Workshop visual={showcase} />);
    const figures = screen.getAllByTestId('printer-figure');
    expect(figures.map((f) => f.getAttribute('data-frame'))).toEqual([
      'acrylic',
      'aluminium',
      'steel',
    ]);
    expect(figures.map((f) => f.getAttribute('data-nozzle'))).toEqual([
      'brass',
      'hardened',
      'glowing',
    ]);
    expect(figures.map((f) => f.getAttribute('data-bed'))).toEqual([
      'tape',
      'heated',
      'auto-level',
    ]);
  });

  it('snapshots each tier so an art change is a reviewed diff', () => {
    for (const slot of showcase.slots.filter((candidate) => candidate.occupied)) {
      cleanup();
      const single: VisualState = { ...showcase, slotCapacity: 1, slots: [{ ...slot, index: 0 }] };
      const { container } = render(<Workshop visual={single} />);
      expect(container.innerHTML).toMatchSnapshot(`machine-tier-${slot.machineTier}`);
    }
  });

  it('only the top tier gets an enclosure', () => {
    render(<Workshop visual={showcase} />);
    expect(
      screen.getAllByTestId('printer-figure').map((f) => f.querySelector('.ph-enclosure')),
    ).toEqual([null, null, expect.anything()]);
  });
});

describe('the idle print-head animation', () => {
  it('desynchronises identical printers from phaseOffset alone', () => {
    render(<Workshop visual={showcase} />);
    const offsets = screen
      .getAllByTestId('printer-figure')
      .map((figure) => (figure as unknown as SVGGElement).style.getPropertyValue('--ph-offset'));
    expect(offsets).toEqual(['0', '0.25', '0.5']);
  });

  it('marks running machines so CSS can speed the sweep up', () => {
    render(<Workshop visual={showcase} />);
    const classes = screen
      .getAllByTestId('printer-figure')
      .map((figure) => figure.getAttribute('class') ?? '');
    expect(classes[0]).toContain('printer--running');
    expect(classes[2]).toContain('printer--idle');
  });

  it('ships the stylesheet inline so the host needs no CSS pipeline', () => {
    const { container } = render(<Workshop visual={fresh} />);
    const style = container.querySelector('style');
    expect(style?.textContent).toContain('@keyframes ph-sweep');
    expect(style?.textContent).toContain('prefers-reduced-motion');
  });
});

describe('the intro assembly (spec §6 phase 0)', () => {
  it('draws only the pieces the player has attached', () => {
    render(<Workshop visual={assembling} />);
    const figure = screen.getByTestId('printer-figure');
    for (const pieceId of assembling.assembly.attachedPieceIds) {
      expect(figure.querySelector(`[data-part="${pieceId}"]`), pieceId).not.toBeNull();
    }
    expect(figure.querySelector('[data-part="controller"]')).toBeNull();
    expect(screen.getByTestId('label-slot-1').textContent).toBe('assembling…');
  });

  it('shows nothing but the bay before the first click', () => {
    render(<Workshop visual={fresh} />);
    const figure = screen.getByTestId('printer-figure');
    expect(figure.querySelector('[data-part="frame"]')).toBeNull();
  });

  it('hands the finished machine over to the slot renderer', () => {
    render(<Workshop visual={printing} />);
    const figure = screen.getByTestId('printer-figure');
    expect(figure.querySelector('[data-part="controller"]')).not.toBeNull();
    expect(screen.getByTestId('label-slot-1').textContent).toBe('Bracket · PLA');
  });

  it('degrades gracefully when content renames a piece', () => {
    const renamed: VisualState = {
      ...assembling,
      assembly: { ...assembling.assembly, attachedPieceIds: ['frame', 'mystery-widget'] },
    };
    render(<Workshop visual={renamed} />);
    const unknown = screen.getByTestId('printer-figure').querySelector('[data-unknown-part]');
    expect(unknown?.getAttribute('data-part')).toBe('mystery-widget');
  });

  it('grows the object on the bed as the batch prints', () => {
    render(<Workshop visual={printing} />);
    const printed = screen.getByTestId('print-in-progress');
    expect(Number(printed.getAttribute('height'))).toBeGreaterThan(0);
    cleanup();
    render(<Workshop visual={fresh} />);
    expect(screen.queryByTestId('print-in-progress')).toBeNull();
  });
});

/**
 * The Goliath path (spec §5B): "the Goliath path replaces them with one large
 * printer". The renderer never learns the fork's id — it switches on the
 * `goliath` flag the projection derives from the branch's own `visual` field.
 */
describe('the Goliath layout (spec §5B)', () => {
  const goliath = visualFixture('goliath');
  const rack = visualFixture('rack');

  it('draws one machine instead of the rack', () => {
    render(<Workshop visual={goliath} />);
    expect(screen.getByTestId('goliath')).not.toBeNull();
    expect(screen.getAllByTestId(/^bay-/)).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('data-layout')).toBe('goliath');
  });

  it('draws it larger than a bay of the rack', () => {
    const { container } = render(<Workshop visual={goliath} />);
    const box = container.querySelector('svg')?.getAttribute('viewBox') ?? '';
    const [, , width, height] = box.split(' ').map(Number);
    expect(width).toBeGreaterThan(workshopWidth(1));
    expect(height).toBeGreaterThan(BAY_HEIGHT);
  });

  it('keeps the count badge, so "one machine" still says how many it is', () => {
    render(<Workshop visual={goliath} />);
    const badge = screen.queryByTestId('count-badge');
    expect(goliath.slots[0]?.printerCount).toBeGreaterThan(1);
    expect(badge).not.toBeNull();
  });

  it('goes back to the rack for a Farm run', () => {
    render(<Workshop visual={rack} />);
    expect(screen.queryByTestId('goliath')).toBeNull();
    expect(screen.getByRole('img').getAttribute('data-layout')).toBe('rack');
  });

  it('draws nothing rather than crashing if the projection has no bay', () => {
    const empty: VisualState = { ...goliath, slots: [] };
    render(<Workshop visual={empty} />);
    expect(screen.queryByTestId('goliath')).toBeNull();
  });
});

/** Print rotas (spec §5B) are drawn on the bay they belong to. */
describe('the rota strip', () => {
  const rack = visualFixture('rack');

  it('draws one pip per rota entry, filling the loaded one', () => {
    render(<Workshop visual={rack} />);
    const queued = rack.slots.find((slot) => slot.queue.length > 1);
    if (queued === undefined) {
      throw new Error('the rack fixture must carry a rota');
    }
    const strip = screen.getByTestId(`queue-${queued.slotId}`);
    expect(strip.getAttribute('data-queue-length')).toBe(String(queued.queue.length));
    expect(strip.querySelectorAll('.ph-queue-pip--current')).toHaveLength(1);
  });

  it('draws nothing for a bay printing a single configuration', () => {
    render(<Workshop visual={rack} />);
    const plain = rack.slots.find((slot) => slot.queue.length <= 1);
    if (plain === undefined) {
      throw new Error('the rack fixture must have a bay without a rota');
    }
    expect(screen.queryByTestId(`queue-${plain.slotId}`)).toBeNull();
  });
});
