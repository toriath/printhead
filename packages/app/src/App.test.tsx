import 'fake-indexeddb/auto';
import { MS_PER_HOUR, MS_PER_SECOND } from '@printhead/core';
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

describe('the assembly bench', () => {
  // jsdom has no PointerEvent; a MouseEvent carries the coordinates a drag needs.
  if (window.PointerEvent === undefined) {
    class PointerEventShim extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    window.PointerEvent = PointerEventShim as unknown as typeof PointerEvent;
  }

  it('seats a piece dropped on the printer, and attaches it once its screws are turned', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const first = store.getContent().start.assemblyPieces[0];
    harness.warp((first?.attachDesignSeconds ?? 0) * MS_PER_SECOND);
    const card = document.querySelector<HTMLButtonElement>(`[data-piece="${first?.id}"]`);
    const target = document.querySelector<HTMLElement>('.bench__printer');
    if (card === null || target === null) {
      throw new Error('expected the bench');
    }
    // jsdom lays nothing out: give the printer a box to aim at.
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;

    fireEvent.pointerDown(card, { clientX: 500, clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(store.getState().assembly.attachedPieceIds).toEqual([]);

    fireEvent.pointerDown(card, { clientX: 500, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 50, clientY: 50, pointerId: 1 });
    // Seated, not fastened: the reducer has not heard about it yet.
    expect(store.getState().assembly.attachedPieceIds).toEqual([]);
    fireEvent.click(screen.getByTestId('screw-0'));
    expect(store.getState().assembly.attachedPieceIds).toEqual([]);
    fireEvent.click(screen.getByTestId('screw-1'));
    expect(store.getState().assembly.attachedPieceIds).toEqual([first?.id]);
    expect(screen.queryByTestId('screw-0')).toBeNull();
  });

  it('switches the controller on with its power button rather than screws', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const pieces = store.getContent().start.assemblyPieces;
    for (const piece of pieces.slice(0, -1)) {
      harness.warp(piece.attachDesignSeconds * MS_PER_SECOND);
      fireEvent.click(screen.getByTestId('attach'));
    }
    const last = pieces.at(-1);
    expect(last?.id).toBe('controller');
    const card = document.querySelector<HTMLButtonElement>(`[data-piece="${last?.id}"]`);
    const target = document.querySelector<HTMLElement>('.bench__printer');
    if (card === null || target === null) {
      throw new Error('expected the bench');
    }
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    fireEvent.pointerDown(card, { clientX: 500, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(card, { clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(card, { clientX: 50, clientY: 50, pointerId: 1 });
    expect(screen.queryByTestId('screw-0')).toBeNull();
    fireEvent.click(screen.getByTestId('power-on'));
    expect(store.getState().assembly.attachedPieceIds).toHaveLength(pieces.length);
  });
});

describe('progressive disclosure', () => {
  const shown = (testId: string): boolean =>
    screen.getByTestId(testId).closest('[hidden]') === null;

  it('brings in each piece of the interface when its idea first matters', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    attachAll(harness, store);
    // A working machine and nothing else: no ledger lines, nothing to sell.
    expect(shown('money')).toBe(false);
    expect(shown('parts')).toBe(false);
    expect(shown('sell')).toBe(false);
    expect(shown('log')).toBe(false);

    fireEvent.click(screen.getByTestId('configure'));
    const object = store.getContent().objects[0];
    harness.warp((object?.printDesignSeconds ?? 0) * MS_PER_SECOND);
    // The first Part: now there is something to count and something to sell.
    expect(shown('parts')).toBe(true);
    expect(shown('sell')).toBe(true);
    expect(shown('log')).toBe(true);
    expect(shown('money')).toBe(false);

    fireEvent.click(screen.getByTestId('sell'));
    expect(shown('money')).toBe(true);
  });
});

describe('keyboard shortcuts', () => {
  it('press the button the screen offers, and nothing the screen withholds', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const first = store.getContent().start.assemblyPieces[0];
    fireEvent.keyDown(window, { key: 'a' });
    expect(store.getState().assembly.attachedPieceIds).toEqual([first?.id]);
    for (const _piece of store.getContent().start.assemblyPieces.slice(1)) {
      fireEvent.keyDown(window, { key: 'a' });
    }
    expect(store.getState().assembly.attachedPieceIds).toHaveLength(
      store.getContent().start.assemblyPieces.length,
    );
    // Sell is on screen but disabled with nothing to sell: the key does nothing.
    fireEvent.keyDown(window, { key: 's' });
    expect(store.getState().stats.partsSold).toBe(0);
  });

  it('stays out of the way while a field has focus or a key is modified', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const first = store.getContent().start.assemblyPieces[0];
    harness.warp((first?.attachDesignSeconds ?? 0) * MS_PER_SECOND);
    fireEvent.keyDown(window, { key: 'a', metaKey: true });
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'a' });
    field.remove();
    expect(store.getState().assembly.attachedPieceIds).toEqual([]);
  });
});

describe('App shell', () => {
  it('opens on the bench and nothing else: no ledger, no panels', async () => {
    const { game } = await boot();
    render(<App store={game.store} />);
    expect(screen.getByTestId('phase').textContent).toBe('intro');
    expect(screen.getByTestId('assembly-bench')).toBeDefined();
    expect(screen.queryByTestId('money')).toBeNull();
    expect(screen.queryByTestId('ledger')).toBeNull();
    expect(screen.queryByTestId('phase-name')).toBeNull();
  });

  it('lets the first piece on straight away: there is nothing to wait for', async () => {
    const { game } = await boot();
    render(<App store={game.store} />);
    const first = game.store.getContent().start.assemblyPieces[0];
    expect(screen.getByTestId('attach')).toHaveProperty('disabled', false);
    expect(screen.getByTestId('attach').textContent).toBe(`Attach ${first?.name}`);
  });

  it('reveals the workshop once the machine is built', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    attachAll(harness, store);
    expect(screen.queryByTestId('assembly-bench')).toBeNull();
    expect(screen.getByTestId('phase-name').textContent).toBe('Intro');
    expect(screen.getByTestId('money').textContent).toBe('$0');
    expect(screen.getByTestId('print-status').textContent).not.toBe('no printer');
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
    expect(screen.getByTestId('money').textContent).not.toBe('$0');
    harness.warp(MS_PER_SECOND);
    expect(screen.getByTestId('phase').textContent).toBe('bench');
  });

  it('draws each attached piece onto the printer on the bench as it is clicked on', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    const pieces = store.getContent().start.assemblyPieces;
    const workshop = screen.getByTestId('bench-printer');
    expect(workshop.querySelectorAll('[data-part]')).toHaveLength(0);

    harness.warp((pieces[0]?.attachDesignSeconds ?? 0) * MS_PER_SECOND);
    fireEvent.click(screen.getByTestId('attach'));
    expect(workshop.querySelector(`[data-part="${pieces[0]?.id}"]`)).not.toBeNull();
  });

  it('re-renders the ledger as the simulation runs', async () => {
    const harness = await boot();
    const { store } = harness.game;
    render(<App store={store} />);
    attachAll(harness, store);
    const before = screen.getByTestId('filament').textContent;
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

describe('time away (spec §7.4: no offline progress)', () => {
  it('resumes a save exactly where it was left, however long ago', async () => {
    const platform = createMemoryPlatform(1_000_000);
    const clock = platform.clock as ManualClock;
    const first = await bootGame({ platform, autoStart: false });
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
    const before = first.store.getState();
    first.loop.stop();

    clock.advance(2 * MS_PER_HOUR);
    const second = await bootGame({ platform, autoStart: false });
    expect(second.store.getState()).toEqual(before);
  });

  it('drops a long spell in the background instead of replaying it', async () => {
    const harness = await boot();
    const { game } = harness;
    render(<App store={game.store} />);
    act(() => {
      game.loop.frame();
    });
    const before = game.store.getState().simTimeMs;
    const clock = game.platform.clock as ManualClock;
    clock.advance(3 * MS_PER_HOUR);
    act(() => {
      game.loop.frame();
    });
    expect(game.store.getState().simTimeMs).toBe(before);
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

    const second = await bootGame({ platform, autoStart: false });
    expect(second.load.kind).toBe('loaded');
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
    expect(back.store.getState().simTimeMs).toBe(game.store.getState().simTimeMs);
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
