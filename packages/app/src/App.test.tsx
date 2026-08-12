import { TICK_MS } from '@printhead/core';
import { createManualClock } from '@printhead/platform';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { type GameStore, createGameStore } from './store.js';

afterEach(cleanup);

const newStore = () => createGameStore({ clock: createManualClock() });

/** Wait out a piece's bench work, then click Attach — as a player would. */
const attachAll = (store: GameStore): void => {
  for (const piece of store.getContent().start.assemblyPieces) {
    act(() => {
      store.advanceWallClock(piece.attachDesignSeconds * 1000);
    });
    fireEvent.click(screen.getByTestId('attach'));
  }
};

describe('App shell', () => {
  it('renders the current phase and the workshop', () => {
    render(<App store={newStore()} />);
    expect(screen.getByTestId('phase').textContent).toBe('intro');
    expect(screen.getByRole('img')).toBeDefined();
  });

  it('walks the whole intro through the UI and lands in bench', () => {
    const store = newStore();
    render(<App store={store} />);

    attachAll(store);
    // Every piece is on: the attach button retires itself.
    expect(screen.queryByTestId('attach')).toBeNull();

    fireEvent.click(screen.getByTestId('configure'));
    fireEvent.click(screen.getByTestId('print'));
    act(() => {
      store.advanceWallClock((store.getContent().objects[0]?.printDesignSeconds ?? 0) * 1000);
    });
    expect(Number(screen.getByTestId('parts').textContent)).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('sell'));
    expect(Number(screen.getByTestId('money').textContent)).toBeGreaterThan(0);
    act(() => {
      store.advanceWallClock(TICK_MS);
    });
    expect(screen.getByTestId('phase').textContent).toBe('bench');
  });

  it('re-renders the ledger as the simulation runs', () => {
    const store = newStore();
    render(<App store={store} />);
    const before = screen.getByTestId('filament').textContent;
    attachAll(store);
    fireEvent.click(screen.getByTestId('configure'));
    fireEvent.click(screen.getByTestId('print'));
    expect(screen.getByTestId('filament').textContent).not.toBe(before);
  });
});
