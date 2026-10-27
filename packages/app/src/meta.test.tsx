import { type VisualState, visualFixture } from '@printhead/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PrestigePanel, StudioPanel } from './meta.js';
import type { GameStore } from './store.js';

afterEach(cleanup);

/**
 * The studio and melt-down panels, rendered against frozen fixtures with a stub
 * store. There is no simulation here on purpose: if a panel needed one, it
 * would mean the shell had grown a rule of its own (spec §15).
 */
function stubStore(): { store: GameStore; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const store = { dispatch: (action: unknown) => dispatched.push(action) } as unknown as GameStore;
  return { store, dispatched };
}

const fresh = visualFixture('fresh');
const printing = visualFixture('printing');
const studio = visualFixture('studio');
const prestige = visualFixture('prestige');
const showcase = visualFixture('showcase');

describe('StudioPanel (spec §5D)', () => {
  it('stays off the screen until the studio can actually be reached', () => {
    const { store } = stubStore();
    render(<StudioPanel store={store} visual={printing} />);
    expect(screen.queryByTestId('studio')).toBeNull();
  });

  it('lists what the studio owns with its level and what a Product is worth', () => {
    const { store } = stubStore();
    render(<StudioPanel store={store} visual={studio} />);
    const owned = studio.studio.designs.filter((row) => row.owned);
    expect(owned.length).toBeGreaterThan(0);
    for (const row of owned) {
      expect(screen.getByTestId(`design-${row.designId}`).textContent).toContain(
        `lv ${row.level}/${row.maxLevel}`,
      );
    }
  });

  it('marks the capstone, because it is the one that unlocks prestige', () => {
    const { store } = stubStore();
    render(<StudioPanel store={store} visual={studio} />);
    const capstone = studio.studio.designs.find((row) => row.capstone);
    expect(capstone).toBeDefined();
    expect(screen.getByTestId(`design-${capstone?.designId ?? ''}`).textContent).toContain('★');
  });

  it('shows the bench when a commission is on it', () => {
    const { store } = stubStore();
    const drafting: VisualState = {
      ...studio,
      studio: {
        ...studio.studio,
        draftingDesignId: 'money-plate',
        draftingName: 'The Money Plate',
        draftProgress: 0.4,
      },
    };
    render(<StudioPanel store={store} visual={drafting} />);
    expect(screen.getByTestId('studio-drafting').textContent).toContain('The Money Plate');
  });

  it('offers a draft the workshop can pay for, and refuses to offer one it cannot', () => {
    const draftable: VisualState = {
      ...showcase,
      studio: {
        ...showcase.studio,
        draftingDesignId: null,
        draftingName: null,
        draftProgress: 0,
        designs: showcase.studio.designs.map((row) =>
          row.capstone
            ? { ...row, owned: false, available: true, affordable: true, blockedReason: null }
            : row,
        ),
      },
    };
    const { store, dispatched } = stubStore();
    const capstone = draftable.studio.designs.find((row) => row.capstone);
    render(<StudioPanel store={store} visual={draftable} />);
    fireEvent.click(screen.getByTestId(`draft-${capstone?.designId ?? ''}`));
    expect(dispatched).toEqual([{ type: 'CREATE_DESIGN', designId: capstone?.designId }]);

    cleanup();
    const broke: VisualState = {
      ...draftable,
      studio: {
        ...draftable.studio,
        designs: draftable.studio.designs.map((row) =>
          row.capstone ? { ...row, affordable: false } : row,
        ),
      },
    };
    render(<StudioPanel store={store} visual={broke} />);
    expect(screen.getByTestId(`draft-${capstone?.designId ?? ''}`).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('says why a commission is not on offer, in the projection’s own words', () => {
    const { store } = stubStore();
    render(<StudioPanel store={store} visual={showcase} />);
    const blocked = showcase.studio.designs.find(
      (row) => !row.owned && !row.available && row.blockedReason !== null,
    );
    expect(blocked).toBeDefined();
    expect(screen.getByTestId(`design-blocked-${blocked?.designId ?? ''}`).textContent).not.toBe(
      '',
    );
  });

  it('loads an owned Design into a staffed bay', () => {
    const { store, dispatched } = stubStore();
    render(<StudioPanel store={store} visual={studio} />);
    const owned = studio.studio.designs.find((row) => row.owned);
    const bay = studio.slots.find((slot) => slot.printerCount > 0 && !slot.changingOver);
    expect(owned).toBeDefined();
    expect(bay).toBeDefined();
    fireEvent.click(screen.getByTestId(`load-${owned?.designId ?? ''}-${bay?.slotId ?? ''}`));
    expect(dispatched).toEqual([
      { type: 'SET_SLOT_DESIGN', slotId: bay?.slotId, designId: owned?.designId },
    ]);
  });

  it('never offers a bay that is mid-purge or has no machines', () => {
    const { store } = stubStore();
    render(<StudioPanel store={store} visual={showcase} />);
    const owned = showcase.studio.designs.find((row) => row.owned);
    for (const slot of showcase.slots) {
      const button = screen.queryByTestId(`load-${owned?.designId ?? ''}-${slot.slotId}`);
      const loadable = slot.printerCount > 0 && !slot.changingOver;
      expect(button === null, slot.slotId).toBe(!loadable);
    }
  });

  it('offers the till only when there are Products on the shelf', () => {
    const { store, dispatched } = stubStore();
    const empty: VisualState = { ...studio, ledger: { ...studio.ledger, products: 0 } };
    render(<StudioPanel store={store} visual={empty} />);
    expect(screen.queryByTestId('sell-products')).toBeNull();
    cleanup();

    render(
      <StudioPanel
        store={store}
        visual={{ ...studio, ledger: { ...studio.ledger, products: 6 } }}
      />,
    );
    fireEvent.click(screen.getByTestId('sell-products'));
    expect(dispatched).toEqual([{ type: 'SELL_PRODUCTS', count: null }]);
  });
});

describe('PrestigePanel (spec §5D, §5E)', () => {
  it('stays hidden while a melt-down is not a prospect at all', () => {
    const { store } = stubStore();
    render(<PrestigePanel store={store} visual={fresh} />);
    expect(screen.queryByTestId('prestige')).toBeNull();
  });

  it('shows the Plates held, the print rate and which run this is', () => {
    const { store } = stubStore();
    render(<PrestigePanel store={store} visual={prestige} />);
    const line = screen.getByTestId('prestige-plates').textContent ?? '';
    expect(line).toContain('plates');
    expect(line).toContain(`run ${prestige.prestige.runsCompleted + 1}`);
  });

  it('offers the melt-down when the projection says it is available', () => {
    const { store, dispatched } = stubStore();
    // The studio fixture is the one caught with the capstone drafted and the
    // melt-down worth taking; `prestige` is the run *after* one, which is
    // saving up for the next.
    render(<PrestigePanel store={store} visual={studio} />);
    expect(studio.prestige.available).toBe(true);
    fireEvent.click(screen.getByTestId('melt-down'));
    // It asks first: nothing is thrown away until the dialog is confirmed.
    expect(dispatched).toEqual([]);
    // A run modifier is picked for the next run; the first offer by default.
    const offers = studio.prestige.offers;
    const second = offers[1];
    if (second !== undefined) {
      fireEvent.click(screen.getByTestId(`run-modifier-${second.id}`));
    }
    fireEvent.click(screen.getByTestId('melt-down-confirm'));
    expect(dispatched).toEqual([
      second === undefined ? { type: 'PRESTIGE' } : { type: 'PRESTIGE', runModifierId: second.id },
    ]);
    expect(screen.queryByTestId('melt-down-dialog')).toBeNull();
  });

  it('disables it and says why when the projection blocks it', () => {
    const { store } = stubStore();
    render(<PrestigePanel store={store} visual={showcase} />);
    const button = screen.getByTestId('melt-down');
    expect(showcase.prestige.available).toBe(false);
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.textContent).toContain('Money Plate');
  });

  it('offers the presses, priced in Plates, and dispatches the purchase', () => {
    const { store, dispatched } = stubStore();
    const press = prestige.moneyPrinters[0];
    render(
      <PrestigePanel
        store={store}
        visual={{
          ...prestige,
          moneyPrinters: prestige.moneyPrinters.map((row) => ({ ...row, affordable: true })),
        }}
      />,
    );
    fireEvent.click(screen.getByTestId(`press-${press?.moneyPrinterId ?? ''}`));
    expect(dispatched).toEqual([
      { type: 'BUY_MONEY_PRINTER', moneyPrinterId: press?.moneyPrinterId },
    ]);
  });

  it('disables a press the Plates cannot cover', () => {
    const { store } = stubStore();
    // Whatever the fixture holds, make one press out of reach.
    const target = prestige.moneyPrinters.find((row) => row.available);
    const broke: VisualState = {
      ...prestige,
      moneyPrinters: prestige.moneyPrinters.map((row) =>
        row === target ? { ...row, affordable: false } : row,
      ),
    };
    const press = broke.moneyPrinters.find((row) => row.available && !row.affordable);
    render(<PrestigePanel store={store} visual={broke} />);
    expect(press?.affordable).toBe(false);
    expect(
      screen.getByTestId(`press-${press?.moneyPrinterId ?? ''}`).hasAttribute('disabled'),
    ).toBe(true);
  });
});
