import { advancePhase } from '@printhead/core';
import { createManualClock } from '@printhead/platform';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { createGameStore } from './store.js';

afterEach(cleanup);

describe('App shell', () => {
  it('renders the current phase and the workshop', () => {
    const store = createGameStore({ clock: createManualClock() });
    render(<App store={store} />);
    expect(screen.getByTestId('phase').textContent).toBe('intro');
    expect(screen.getByRole('img')).toBeDefined();
  });

  it('re-renders when the store advances the phase', () => {
    const store = createGameStore({ clock: createManualClock() });
    render(<App store={store} />);
    act(() => {
      store.dispatch(advancePhase());
    });
    expect(screen.getByTestId('phase').textContent).toBe('bench');
  });
});
