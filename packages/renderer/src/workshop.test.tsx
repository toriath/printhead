import { type VisualState, visualFixture, visualStateFixtures } from '@printhead/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BAY_HEIGHT,
  BAY_WIDTH,
  FLOOR_HEIGHT,
  FLOOR_WIDTH,
  PRESS_HEIGHT,
  workshopWidth,
} from './geometry.js';
import {
  Workshop,
  bays,
  clampToFloor,
  floorScale,
  installedPresses,
  pileSize,
} from './workshop.js';

afterEach(cleanup);

const fresh = visualFixture('fresh');
const assembling = visualFixture('assembling');
const printing = visualFixture('printing');
const showcase = visualFixture('showcase');
const studio = visualFixture('studio');
const prestige = visualFixture('prestige');

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

  it('sizes its viewBox from the rack it drew, plus the mint if there is one', () => {
    render(<Workshop visual={showcase} />);
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe(
      `0 0 ${workshopWidth(showcase.slotCapacity)} ${BAY_HEIGHT + PRESS_HEIGHT}`,
    );
    cleanup();
    render(<Workshop visual={fresh} />);
    expect(screen.getByRole('img').getAttribute('viewBox')).toBe(
      `0 0 ${workshopWidth(fresh.slotCapacity)} ${BAY_HEIGHT}`,
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

  it('draws a Product differently from a Part (spec §5D)', () => {
    const bay = studio.slots.find((slot) => slot.output === 'products');
    expect(bay, 'the studio fixture should have a bay making Products').toBeDefined();
    render(<Workshop visual={studio} />);
    const products = screen
      .getAllByTestId('print-in-progress')
      .filter((node) => node.getAttribute('data-output') === 'products');
    expect(products.length).toBeGreaterThan(0);
    for (const node of products) {
      expect(node.getAttribute('class')).toContain('ph-print--product');
    }
  });

  it('marks the bay making Products, and names its Design', () => {
    render(<Workshop visual={studio} />);
    const bays_ = screen.getAllByTestId(/^slot-/);
    const onDesign = bays_.filter((node) => node.getAttribute('data-output') === 'products');
    expect(onDesign).toHaveLength(studio.slots.filter((slot) => slot.output === 'products').length);
    const design = studio.slots.find((slot) => slot.designId !== null);
    expect(design).toBeDefined();
    expect(screen.getByTestId(`label-${design?.slotId ?? ''}`).textContent).toContain(
      design?.objectName ?? '',
    );
  });

  it('says the workshop is rebuilding itself after a melt-down (spec §6 phase 4)', () => {
    render(<Workshop visual={prestige} />);
    expect(screen.getByRole('img').getAttribute('data-self-assembling')).toBe('true');
    cleanup();
    render(<Workshop visual={fresh} />);
    expect(screen.getByRole('img').getAttribute('data-self-assembling')).toBe('false');
  });

  it('captions a self-assembling intro differently from a clicked one', () => {
    const rebuilding: VisualState = {
      ...prestige,
      assembly: { ...prestige.assembly, complete: false, attachedPieceIds: ['frame'] },
    };
    render(<Workshop visual={rebuilding} />);
    expect(screen.getByTestId(`label-${rebuilding.slots[0]?.slotId ?? ''}`).textContent).toBe(
      'self-assembling…',
    );
    cleanup();
    render(<Workshop visual={assembling} />);
    expect(screen.getByTestId(`label-${assembling.slots[0]?.slotId ?? ''}`).textContent).toBe(
      'assembling…',
    );
  });

  describe('the mint (spec §5E)', () => {
    it('appears only once a press is installed, one bill per level', () => {
      render(<Workshop visual={prestige} />);
      const bills = installedPresses(prestige);
      expect(bills.length).toBeGreaterThan(0);
      const mint = screen.getByTestId('mint');
      expect(mint.getAttribute('data-press-levels')).toBe(String(bills.length));
      expect(mint.querySelectorAll('.ph-bill')).toHaveLength(bills.length);
    });

    it('is absent before the first press, so the Plates are not implied', () => {
      render(<Workshop visual={printing} />);
      expect(screen.queryByTestId('mint')).toBeNull();
    });
  });

  it('only the top tier gets an enclosure', () => {
    // A resin bay draws Amber whatever its tier, so the top-tier bay here is
    // loaded with PLA to show the enclosed Mk3.
    render(
      <Workshop
        visual={{
          ...showcase,
          slots: showcase.slots.map((slot) =>
            slot.machineTier === 3 ? { ...slot, materialId: 'pla', output: 'parts' } : slot,
          ),
        }}
      />,
    );
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

describe('the free-standing floor', () => {
  const rack = visualFixture('rack');

  it('stands only the bays the workshop owns, with no boxes and no locked outlines', () => {
    render(<Workshop visual={rack} layout="floor" />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('data-layout')).toBe('floor');
    expect(svg.querySelectorAll('[data-lead]')).toHaveLength(rack.slots.length);
    expect(svg.querySelectorAll('.ph-bay--empty')).toHaveLength(0);
    expect(svg.querySelectorAll('[data-testid="count-badge"]')).toHaveLength(0);
  });

  it('draws every printer a bay owns, in person, up to a crew of eight', () => {
    const [bay] = rack.slots;
    if (bay === undefined) {
      throw new Error('the rack fixture needs a bay');
    }
    const crewOf = (count: number): VisualState => ({
      ...rack,
      slots: [{ ...bay, printerCount: count }],
    });
    const figures = (count: number): number => {
      cleanup();
      render(<Workshop visual={crewOf(count)} layout="floor" />);
      return screen.getByRole('img').querySelectorAll('[data-testid="printer-figure"]').length;
    };
    expect(figures(1)).toBe(1);
    expect(figures(5)).toBe(5);
    expect(figures(8)).toBe(8);
    expect(figures(12)).toBe(8);
    expect(screen.getByTestId(`crew-more-${bay.slotId}`).textContent).toBe('+4');
  });

  it('puts a bay where it was placed, nearer bays bigger and drawn in front', () => {
    const [back, front] = rack.slots;
    if (back === undefined || front === undefined) {
      throw new Error('the rack fixture needs two bays');
    }
    render(
      <Workshop
        visual={rack}
        layout="floor"
        positions={{ [back.slotId]: { x: 0.2, y: 0.1 }, [front.slotId]: { x: 0.8, y: 0.9 } }}
      />,
    );
    const spots = [...screen.getByRole('img').querySelectorAll('[data-lead]')];
    const order = spots.map((spot) => spot.getAttribute('data-slot-id'));
    expect(order.indexOf(back.slotId)).toBeLessThan(order.indexOf(front.slotId));
    const scaleOf = (id: string): number =>
      Number(
        /scale\(([\d.]+)\)/.exec(
          spots
            .find((spot) => spot.getAttribute('data-slot-id') === id)
            ?.getAttribute('transform') ?? '',
        )?.[1],
      );
    expect(scaleOf(front.slotId)).toBeGreaterThan(scaleOf(back.slotId));
  });

  it('leaves the rack layout exactly as it was by default', () => {
    render(<Workshop visual={rack} />);
    expect(screen.getByRole('img').getAttribute('data-layout')).toBe('rack');
  });
});

describe('clampToFloor', () => {
  it('keeps a printer wholly on the floor however far it is dragged', () => {
    for (const wild of [
      { x: -3, y: -3 },
      { x: 5, y: 5 },
      { x: 0.5, y: 0 },
      { x: 0, y: 1 },
    ]) {
      const { x, y } = clampToFloor(wild);
      const scale = floorScale(y);
      const top = y * FLOOR_HEIGHT - BAY_HEIGHT * scale;
      const left = x * FLOOR_WIDTH - (BAY_WIDTH * scale) / 2;
      const right = x * FLOOR_WIDTH + (BAY_WIDTH * scale) / 2;
      expect(top).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeLessThanOrEqual(1);
      expect(left).toBeGreaterThanOrEqual(-1e-9);
      expect(right).toBeLessThanOrEqual(FLOOR_WIDTH + 1e-9);
    }
  });

  it('leaves a spot already on the floor alone', () => {
    expect(clampToFloor({ x: 0.5, y: 0.8 })).toEqual({ x: 0.5, y: 0.8 });
  });
});

describe('the stock pile', () => {
  it('grows by a few items per doubling, and never past its cap', () => {
    expect(pileSize(0)).toBe(0);
    expect(pileSize(1)).toBeGreaterThan(0);
    expect(pileSize(100)).toBeGreaterThan(pileSize(10));
    expect(pileSize(1e12)).toBe(28);
  });

  it('piles what is in stock on the floor, and nothing when the shelf is bare', () => {
    const rack = visualFixture('rack');
    const stocked: VisualState = { ...rack, ledger: { ...rack.ledger, parts: 40, products: 3 } };
    render(<Workshop visual={stocked} layout="floor" />);
    const pile = screen.getByTestId('stock-pile');
    expect(pile.querySelectorAll('.ph-pile-item')).toHaveLength(pileSize(40) + pileSize(3));
    expect(pile.querySelectorAll('.ph-pile-item--product')).toHaveLength(pileSize(3));
    cleanup();
    const bare: VisualState = { ...rack, ledger: { ...rack.ledger, parts: 0, products: 0 } };
    render(<Workshop visual={bare} layout="floor" />);
    expect(screen.queryByTestId('stock-pile')).toBeNull();
  });
});

describe('the workshop wall', () => {
  const wallOf = (phaseId: string): string[] => {
    cleanup();
    const rack = visualFixture('rack');
    render(<Workshop visual={{ ...rack, phaseId }} layout="floor" />);
    return [...screen.getByTestId('workshop-wall').querySelectorAll('[data-wall]')].map(
      (item) => item.getAttribute('data-wall') ?? '',
    );
  };

  it('starts bare and fills up, layer by layer, never losing what it hung', () => {
    const intro = wallOf('intro');
    const farm = wallOf('farm');
    const absurd = wallOf('absurd');
    const end = wallOf('end');
    expect(intro).toEqual(['pegboard', 'window']);
    expect(farm).toEqual(expect.arrayContaining([...intro, 'shelf', 'clock']));
    expect(absurd).toEqual(expect.arrayContaining([...farm, 'blueprint', 'plates', 'neon']));
    expect(end).toEqual(expect.arrayContaining([...absurd, 'lights']));
  });

  it('shows a bare wall for a phase it does not know', () => {
    expect(wallOf('somewhere-new')).toEqual(['pegboard', 'window']);
  });
});
