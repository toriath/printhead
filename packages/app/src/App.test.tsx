import 'fake-indexeddb/auto';
import {
  MS_PER_HOUR,
  MS_PER_SECOND,
  RAW_CONTENT,
  createStaticContentSource,
} from '@printhead/core';
import { type ManualClock, type ManualLifecycle, createMemoryPlatform } from '@printhead/platform';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { type BootedGame, bootGame } from './boot.js';
import { writeSave } from './persistence.js';
import type { GameStore } from './store.js';

afterEach(cleanup);

/** Let queued IndexedDB writes settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Harness {
  readonly game: BootedGame;
  readonly clock: ManualClock;
  /** Advance wall time and run one frame, as the rAF pump would. */
  warp(ms: number): void;
}

async function boot(startMs = 1_000_000): Promise<Harness> {
  const platform = createMemoryPlatform(startMs);
  const clock = platform.clock as ManualClock;
  const game = await bootGame({ platform, autoStart: false });
  return {
    game,
    clock,
    warp(ms) {
      act(() => {
        clock.advance(ms);
        game.loop.frame();
      });
    },
  };
}

/** Wait out each piece's bench work, then click Attach — as a player would. */
function attachAll(harness: Harness, store: GameStore): void {
  for (const piece of store.getContent().start.assemblyPieces) {
    harness.warp(piece.attachDesignSeconds * MS_PER_SECOND);
    fireEvent.click(screen.getByTestId('attach'));
  }
}

describe('App shell', () => {
  it('renders the phase, the HUD and the workshop', async () => {
    const { game } = await boot();
    render(<App store={game.store} />);
    expect(screen.getByTestId('phase').textContent).toBe('intro');
    expect(screen.getByTestId('phase-name').textContent).toBe('Intro');
    expect(screen.getByRole('img')).toBeDefined();
    expect(screen.getByTestId('money').textContent).toBe('¤0');
    expect(screen.getByTestId('print-status').textContent).toBe('no printer');
  });

  it('keeps the attach button disabled until the bench work is done', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const first = store.getContent().start.assemblyPieces[0];
    const attach = screen.getByTestId('attach');
    expect(attach).toHaveProperty('disabled', true);
    expect(attach.textContent).toContain('s');

    harness.warp((first?.attachDesignSeconds ?? 0) * MS_PER_SECOND);
    expect(screen.getByTestId('attach')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('attach').textContent).toBe(`Attach ${first?.name}`);
  });

  it('walks the whole intro through the UI and lands in bench', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);

    attachAll(harness, store);
    expect(screen.queryByTestId('attach')).toBeNull();

    fireEvent.click(screen.getByTestId('configure'));
    fireEvent.click(screen.getByTestId('print'));
    expect(screen.getByTestId('print-status').textContent).toContain('printing Bracket');

    harness.warp((store.getContent().objects[0]?.printDesignSeconds ?? 0) * MS_PER_SECOND);
    expect(Number(screen.getByTestId('parts').textContent)).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('sell'));
    expect(screen.getByTestId('money').textContent).not.toBe('¤0');
    harness.warp(MS_PER_SECOND);
    expect(screen.getByTestId('phase').textContent).toBe('bench');
  });

  it('draws each attached piece onto the printer as it is clicked on', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const pieces = store.getContent().start.assemblyPieces;
    const workshop = screen.getByRole('img');
    expect(workshop.querySelectorAll('[data-part]')).toHaveLength(0);

    harness.warp((pieces[0]?.attachDesignSeconds ?? 0) * MS_PER_SECOND);
    fireEvent.click(screen.getByTestId('attach'));
    expect(workshop.querySelector(`[data-part="${pieces[0]?.id}"]`)).not.toBeNull();
  });

  it('re-renders the ledger as the simulation runs', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const before = screen.getByTestId('filament').textContent;
    attachAll(harness, store);
    fireEvent.click(screen.getByTestId('configure'));
    fireEvent.click(screen.getByTestId('print'));
    expect(screen.getByTestId('filament').textContent).not.toBe(before);
  });

  it('refuses to offer actions the phase forbids', async () => {
    const { game } = await boot();
    render(<App store={game.store} />);
    // BUY_FILAMENT and BUY_PRINTER are not in the intro's allow-list.
    expect(screen.queryByTestId('buy-filament')).toBeNull();
    expect(screen.queryByTestId('buy-printer')).toBeNull();
  });

  it('warns when a save existed but could not be read', async () => {
    const { game } = await boot();
    render(<App store={game.store} loadWarning="Your save could not be read." />);
    expect(screen.getByTestId('load-warning').textContent).toBe('Your save could not be read.');
  });
});

describe('the offline summary screen (spec §7.4)', () => {
  it('shows what the workshop did while the player was away, then dismisses', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const clock = platform.clock as ManualClock;
    const first = await bootGame({ platform, autoStart: false });

    // Get a printer running, then save and come back two hours later.
    const store = first.store;
    const content = store.getContent();
    for (const piece of content.start.assemblyPieces) {
      clock.advance(piece.attachDesignSeconds * MS_PER_SECOND);
      first.loop.frame();
      store.dispatch({ type: 'ATTACH_PIECE', pieceId: piece.id });
    }
    const slotId = store.getVisualState().slots[0]?.slotId ?? '';
    store.dispatch({ type: 'SET_SLOT_CONFIG', slotId, materialId: 'pla', objectId: 'bracket' });
    store.dispatch({ type: 'START_PRINT', slotId });
    await first.autosave.saveNow();
    first.loop.stop();

    clock.advance(2 * MS_PER_HOUR);
    const second = await bootGame({ platform, autoStart: false });
    expect(second.offline).not.toBeNull();

    render(<App store={second.store} initialOffline={second.offline} />);
    expect(screen.getByTestId('offline-summary')).toBeDefined();
    expect(screen.getByTestId('offline-away').textContent).toContain('2 h');
    expect(Number(screen.getByTestId('offline-prints').textContent)).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('offline-dismiss'));
    expect(screen.queryByTestId('offline-summary')).toBeNull();
  });

  it('says so when the offline cap swallowed part of the absence', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const clock = platform.clock as ManualClock;
    const content = createStaticContentSource(RAW_CONTENT).get();
    const seed = await bootGame({ platform, autoStart: false });
    await seed.autosave.saveNow();
    clock.advance((content.pacing.offlineCapHours + 5) * MS_PER_HOUR);

    const back = await bootGame({ platform, autoStart: false });
    render(<App store={back.store} initialOffline={back.offline} />);
    expect(screen.getByTestId('offline-capped').textContent).toContain('5 h');
  });

  it('appears when the tab comes back after a long spell in the background', async () => {
    const harness = await boot();
    const { game } = harness;
    render(
      <App
        store={game.store}
        initialOffline={game.offline}
        subscribeOffline={game.subscribeOffline}
      />,
    );
    expect(screen.queryByTestId('offline-summary')).toBeNull();

    // The loop's first frame establishes "now"; the next one arrives late.
    act(() => {
      game.loop.frame();
    });
    harness.warp(3 * MS_PER_HOUR);
    expect(screen.getByTestId('offline-summary')).toBeDefined();
  });
});

describe('save and reload', () => {
  it('restores exactly the state that was written', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const clock = platform.clock as ManualClock;
    const first = await bootGame({ platform, autoStart: false });
    clock.advance(30 * MS_PER_SECOND);
    first.loop.frame();
    first.loop.frame();
    await first.autosave.saveNow();
    const before = first.store.getState();

    // No wall time passes, so there is nothing to catch up on.
    const second = await bootGame({ platform, autoStart: false });
    expect(second.load.kind).toBe('loaded');
    expect(second.offline).toBeNull();
    expect(second.store.getState()).toEqual(before);
  });

  it('starts a fresh workshop when the stored save is corrupt', async () => {
    const platform = createMemoryPlatform(1_000_000);
    await platform.storage.write('printhead/save', '{"nope":');
    const game = await bootGame({ platform, autoStart: false });
    expect(game.load.kind).toBe('unreadable');
    expect(game.store.getState().phaseId).toBe('intro');
  });

  it('ignores a save stamped in the future rather than running time backwards', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const game = await bootGame({ platform, autoStart: false });
    await writeSave({ storage: platform.storage }, game.store.getState(), 9_000_000);
    const back = await bootGame({ platform, autoStart: false });
    expect(back.offline).toBeNull();
  });
});

describe('boot wiring', () => {
  it('autosaves as the simulation runs, without a save per frame', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const clock = platform.clock as ManualClock;
    const game = await bootGame({ platform, autoStart: false, autosaveIntervalMs: 10_000 });
    clock.advance(MS_PER_SECOND);
    game.loop.frame();
    await settle();
    const firstSave = game.autosave.lastSavedAtMs();
    expect(firstSave).not.toBeNull();

    clock.advance(MS_PER_SECOND);
    game.loop.frame();
    await settle();
    expect(game.autosave.lastSavedAtMs()).toBe(firstSave);

    clock.advance(20 * MS_PER_SECOND);
    game.loop.frame();
    await settle();
    expect(game.autosave.lastSavedAtMs()).not.toBe(firstSave);
  });

  it('saves when the game goes to the background', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const game = await bootGame({ platform });
    const lifecycle = platform.lifecycle as ManualLifecycle;
    lifecycle.setVisible(false);
    await settle();
    expect(await platform.storage.read('printhead/save')).not.toBeNull();
    await game.shutdown();
  });

  it('shuts down cleanly, stopping the loop and flushing a save', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const game = await bootGame({ platform });
    expect(game.loop.isRunning()).toBe(true);
    await game.shutdown();
    expect(game.loop.isRunning()).toBe(false);
    expect(await platform.storage.read('printhead/save')).not.toBeNull();
  });
});
