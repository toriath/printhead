import { type VisualState, visualFixture } from '@printhead/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FleetPanel, bayStatus } from './fleet.js';
import type { GameStore } from './store.js';

afterEach(cleanup);

/**
 * The fleet allocator (spec §4, §5B), rendered against frozen `VisualState`
 * fixtures with a stub store. It has no rule of its own — every "can I?" was
 * resolved by the projection — so what these tests check is that it offers
 * exactly what the projection says is offerable, and dispatches nothing else.
 */
function stubStore(): { store: GameStore; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const store = { dispatch: (action: unknown) => dispatched.push(action) } as unknown as GameStore;
  return { store, dispatched };
}

const fresh = visualFixture('fresh');
const rack = visualFixture('rack');
const goliath = visualFixture('goliath');

const affordable = (visual: VisualState): VisualState => ({
  ...visual,
  slotUnlock:
    visual.slotUnlock === null
      ? null
      : { ...visual.slotUnlock, available: true, affordable: true, blockedReason: null },
});

describe('FleetPanel', () => {
  it('stays out of the way while there is nothing to allocate', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={fresh} />);
    expect(screen.queryByTestId('fleet')).toBeNull();
  });

  it('appears as soon as the next bay is on sale', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={affordable(fresh)} />);
    expect(screen.queryByTestId('fleet')).not.toBeNull();
  });

  it('shows a row per bay with its machines, its ceiling and what it is doing', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={rack} />);
    for (const slot of rack.slots) {
      const status = screen.getByTestId(`bay-status-${slot.slotId}`);
      expect(status.textContent).toContain(`${slot.printerCount}/${slot.printerCapacity}`);
    }
    expect(screen.getByTestId('fleet-summary').textContent).toContain(
      `${rack.fleet.slotsActive}/${rack.fleet.slotsMaximum} bays`,
    );
  });

  it('walks a machine to the next bay with room', () => {
    const { store, dispatched } = stubStore();
    render(<FleetPanel store={store} visual={rack} />);
    const from = rack.slots[0];
    const to = rack.slots[1];
    if (from === undefined || to === undefined) {
      throw new Error('the rack fixture must have two bays');
    }
    fireEvent.click(screen.getByTestId(`move-out-${from.slotId}`));
    expect(dispatched).toEqual([
      { type: 'ASSIGN_PRINTER', fromSlotId: from.slotId, toSlotId: to.slotId, count: 1 },
    ]);
  });

  it('will not offer a move out of an empty bay', () => {
    const { store } = stubStore();
    const emptied: VisualState = {
      ...rack,
      slots: rack.slots.map((slot, index) => (index === 0 ? { ...slot, printerCount: 0 } : slot)),
    };
    render(<FleetPanel store={store} visual={emptied} />);
    expect(screen.getByTestId(`move-out-${rack.slots[0]?.slotId}`).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('shows the rota a bay is working through, marking the loaded entry', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={rack} />);
    const queued = rack.slots.find((slot) => slot.queue.length > 0);
    if (queued === undefined) {
      throw new Error('the rack fixture must carry a rota');
    }
    const rota = screen.getByTestId(`rota-${queued.slotId}`);
    expect(rota.querySelectorAll('li')).toHaveLength(queued.queue.length);
    expect(rota.querySelectorAll('[data-current="true"]')).toHaveLength(1);
    fireEvent.click(screen.getByTestId(`clear-rota-${queued.slotId}`));
  });

  it('offers the next bay at the price the projection quotes, and says why not', () => {
    const { store, dispatched } = stubStore();
    const blocked: VisualState = {
      ...rack,
      slotUnlock:
        rack.slotUnlock === null
          ? null
          : { ...rack.slotUnlock, available: false, affordable: false, blockedReason: 'locked' },
    };
    const { unmount } = render(<FleetPanel store={store} visual={blocked} />);
    expect(screen.getByTestId('buy-slot').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('slot-unlock-blocked').textContent).toContain('locked');
    unmount();

    render(<FleetPanel store={store} visual={affordable(rack)} />);
    fireEvent.click(screen.getByTestId('buy-slot'));
    expect(dispatched).toEqual([{ type: 'BUY_SLOT', unlockId: rack.slotUnlock?.unlockId ?? '' }]);
  });
});

describe('the Farm/Goliath fork in the shell (spec §5B)', () => {
  it('offers both branches while the run is uncommitted', () => {
    const { store, dispatched } = stubStore();
    const open: VisualState = {
      ...rack,
      forks: rack.forks.map((fork) => ({ ...fork, available: true, affordable: true })),
    };
    render(<FleetPanel store={store} visual={open} />);
    for (const fork of open.forks) {
      expect(screen.queryByTestId(`fork-${fork.forkId}`)).not.toBeNull();
    }
    fireEvent.click(screen.getByTestId(`fork-${open.forks[0]?.forkId}`));
    expect(dispatched).toEqual([{ type: 'CHOOSE_FORK', forkId: open.forks[0]?.forkId }]);
  });

  it('shows only the committed branch once the run has chosen', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={goliath} />);
    const chosen = goliath.forks.find((fork) => fork.chosen);
    if (chosen === undefined) {
      throw new Error('the goliath fixture must have a committed fork');
    }
    expect(screen.queryByTestId(`fork-chosen-${chosen.forkId}`)).not.toBeNull();
    for (const other of goliath.forks.filter((fork) => !fork.chosen)) {
      expect(screen.queryByTestId(`fork-${other.forkId}`)).toBeNull();
    }
  });

  it('still shows the fleet after the rack has been melted into one machine', () => {
    const { store } = stubStore();
    render(<FleetPanel store={store} visual={goliath} />);
    expect(screen.queryByTestId('fleet')).not.toBeNull();
    expect(screen.getByTestId('fleet-summary').textContent).toContain('1/');
  });
});

describe('bayStatus', () => {
  const slot = rack.slots[0];
  if (slot === undefined) {
    throw new Error('the rack fixture must have a bay');
  }

  it('describes a purge, a run, an empty bay and an idle one', () => {
    expect(bayStatus({ ...slot, changingOver: true })).toContain('purging');
    expect(bayStatus({ ...slot, changingOver: false, running: true, batch: 3 })).toContain('×3');
    expect(bayStatus({ ...slot, changingOver: false, running: false, printerCount: 0 })).toBe(
      'no machines',
    );
    expect(
      bayStatus({
        ...slot,
        changingOver: false,
        running: false,
        printerCount: 1,
        materialId: null,
      }),
    ).toBe('no config loaded');
    expect(bayStatus({ ...slot, changingOver: false, running: false, printerCount: 1 })).toBe(
      'idle',
    );
  });
});
