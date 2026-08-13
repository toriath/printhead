import 'fake-indexeddb/auto';
import {
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  RAW_CONTENT,
  type VisualState,
  createInitialState,
  createMutableContentSource,
  createStaticContentSource,
  loadContent,
  toVisualState,
  visualFixture,
} from '@printhead/core';
import { createManualClock, createMemoryStorage } from '@printhead/platform';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutosave } from './autosave.js';
import { buildControlModel } from './controls-model.js';
import { CONTENT_HMR_EVENT, connectContentHotReload } from './dev/content-hot-reload.js';
import { BOOT_OVERRIDES_KEY, readBootOverrides } from './dev/hooks.js';
import {
  formatAmount,
  formatCountdown,
  formatDuration,
  formatGrams,
  formatMoney,
  formatPercent,
} from './format.js';
import { useGameSelector, useVisualState } from './hooks.js';
import { Hud, printStatus } from './hud.js';
import { OFFLINE_THRESHOLD_MS, createGameLoop } from './loop.js';
import { readSave, writeSave } from './persistence.js';
import { createGameStore } from './store.js';

afterEach(cleanup);

const content = loadContent(RAW_CONTENT);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('display formatting', () => {
  it('keeps integers integral and fractions readable', () => {
    expect(formatAmount(12)).toBe('12');
    expect(formatAmount(1.234)).toBe('1.23');
    expect(formatAmount(123.456)).toBe('123.5');
    expect(formatMoney(3)).toBe('¤3');
    expect(formatGrams(40)).toBe('40 g');
  });

  it('clamps percentages to the 0..1 the projection promises', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(2)).toBe('100%');
  });

  it('formats durations at the granularity a player cares about', () => {
    expect(formatDuration(45 * MS_PER_SECOND)).toBe('45 s');
    expect(formatDuration(3 * MS_PER_MINUTE + 5 * MS_PER_SECOND)).toBe('3 m 5 s');
    expect(formatDuration(2 * MS_PER_HOUR + 30 * MS_PER_MINUTE)).toBe('2 h 30 m');
    expect(formatDuration(-1)).toBe('0 s');
  });

  it('rounds a countdown up, so "1 s" never means "already done"', () => {
    expect(formatCountdown(1)).toBe('1 s');
    expect(formatCountdown(0)).toBe('0 s');
    expect(formatCountdown(2400)).toBe('3 s');
  });
});

describe('the HUD reveals a mechanic only once it exists', () => {
  it('hides Scrap until a print has actually failed', () => {
    const content = loadContent(RAW_CONTENT);
    const clean = visualFixture('printing');
    expect(clean.ledger.scrap).toBe(0);
    const { unmount } = render(<Hud visual={clean} content={content} />);
    expect(screen.queryByTestId('scrap')).toBeNull();
    unmount();

    const scrapped = visualFixture('economy');
    expect(scrapped.ledger.scrap).toBeGreaterThan(0);
    render(<Hud visual={scrapped} content={content} />);
    expect(screen.getByTestId('scrap').textContent).toContain('g');
  });
});

describe('HUD status line', () => {
  it('describes the fleet from the projection alone', () => {
    expect(printStatus(visualFixture('fresh'))).toBe('no printer');
    expect(printStatus(visualFixture('assembled'))).toBe('idle');
    expect(printStatus(visualFixture('printing'))).toBe('printing Bracket — 50%');
  });

  it('counts the other running slots without listing them', () => {
    expect(printStatus(visualFixture('showcase'))).toBe('printing Bracket ×7 — 50% (+1 more)');
  });
});

describe('the control model', () => {
  const freshState = createInitialState(content, { seed: 1 });
  const freshVisual = toVisualState(freshState, content);

  it('offers only what the intro phase allows', () => {
    const model = buildControlModel(freshState, content, freshVisual);
    expect(model.allows('ATTACH_PIECE')).toBe(true);
    expect(model.allows('BUY_PRINTER')).toBe(false);
    expect(model.buyPrinter).toBeNull();
    expect(model.buyFilament).toBeNull();
  });

  it('keeps the attach button off until the bench work is done', () => {
    expect(buildControlModel(freshState, content, freshVisual).attach).toMatchObject({
      pieceId: content.start.assemblyPieces[0]?.id,
      enabled: false,
    });
    const ready = { ...freshState, assembly: { ...freshState.assembly, cooldownMs: 0 } };
    expect(buildControlModel(ready, content, toVisualState(ready, content)).attach?.enabled).toBe(
      true,
    );
  });

  it('lists only the materials and objects the phase has unlocked', () => {
    const model = buildControlModel(freshState, content, freshVisual);
    expect(model.materials.map((option) => option.id)).toEqual(['pla']);
    expect(model.objects.map((option) => option.id)).toEqual(['bracket']);
  });

  it('will not offer a print the reducer would refuse', () => {
    expect(buildControlModel(freshState, content, freshVisual).canPrint).toBe(false);
    const printing = visualFixture('printing');
    const running = { ...printing, slots: printing.slots.map((s) => ({ ...s, running: true })) };
    expect(buildControlModel(freshState, content, running as VisualState).canPrint).toBe(false);
  });

  /**
   * Regression: the model used to read the batch's filament out of
   * `content.objects` by the bay's `objectId`. A bay printing a Design has no
   * `objectId` (spec §5D), so it computed zero grams per print, disabled the
   * Print button forever and made the whole Product economy unreachable from
   * the UI. It now asks the simulation what the bay is loaded with.
   */
  it('offers a print for a bay loaded with a Design, not just a stock object', () => {
    const capstoneId = content.prestige.requiredDesignId;
    const capstone = content.designs.find((def) => def.id === capstoneId);
    const studio = {
      ...freshState,
      phaseId: 'studio',
      printers: { 'bench-mk1': 1 },
      upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
      designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } },
      filamentGrams: { ...freshState.filamentGrams, resin: 5000 },
      slots: freshState.slots.map((slot) => ({
        ...slot,
        materialId: capstone?.requiredMaterialId ?? 'resin',
        objectId: null,
        designId: capstoneId,
        printerCount: 1,
      })),
    };
    const model = buildControlModel(studio, content, toVisualState(studio, content));
    expect(model.canPrint).toBe(true);
    // ...and the restock button quotes the Design's own appetite.
    expect(model.buyFilament?.materialId).toBe(capstone?.requiredMaterialId);
  });

  it('prices the next printer from the cost curve, and gates it on the ledger', () => {
    const bench = { ...freshState, phaseId: 'bench', printers: { 'bench-mk1': 1 } };
    const model = buildControlModel(bench, content, toVisualState(bench, content));
    expect(model.buyPrinter?.cost).toBeGreaterThan(0);
    expect(model.buyPrinter?.enabled).toBe(false);

    const rich = { ...bench, resources: { ...bench.resources, parts: 10_000 }, partsValue: 10_000 };
    expect(buildControlModel(rich, content, toVisualState(rich, content)).buyPrinter?.enabled).toBe(
      true,
    );
  });

  it('stops offering a printer once the bay is full (spec §4)', () => {
    const ceiling = content.start.printersPerSlot;
    const rich = {
      ...freshState,
      phaseId: 'bench',
      printers: { 'bench-mk1': ceiling },
      resources: { ...freshState.resources, parts: 100_000 },
      partsValue: 100_000,
      slots: freshState.slots.map((slot) => ({ ...slot, printerCount: ceiling })),
    };
    // The ledger can pay; the rack cannot house it. The answer is another bay,
    // which is the fleet panel's job — so the button here goes dark.
    expect(buildControlModel(rich, content, toVisualState(rich, content)).buyPrinter?.enabled).toBe(
      false,
    );
    const roomy = { ...rich, slots: rich.slots.map((slot) => ({ ...slot, printerCount: 0 })) };
    expect(
      buildControlModel(roomy, content, toVisualState(roomy, content)).buyPrinter?.enabled,
    ).toBe(true);
  });

  it('points the panel at the bay it is asked about', () => {
    const bareSlot = freshState.slots[0];
    if (bareSlot === undefined) {
      throw new Error('a fresh save always has one bay');
    }
    const racked = {
      ...freshState,
      phaseId: 'farm',
      printers: { 'bench-mk1': 2 },
      slots: ['slot-1', 'slot-2'].map((id) => ({ ...bareSlot, id, printerCount: 1 })),
    };
    const visual = toVisualState(racked, content);
    expect(buildControlModel(racked, content, visual).slotId).toBe('slot-1');
    expect(buildControlModel(racked, content, visual, 'slot-2').slotId).toBe('slot-2');
    expect(buildControlModel(racked, content, visual).slots.map((o) => o.id)).toEqual([
      'slot-1',
      'slot-2',
    ]);
    // An unknown bay falls back to the first rather than producing an empty id.
    expect(buildControlModel(racked, content, visual, 'ghost').slotId).toBe('slot-1');
  });

  it('offers the rota only once the auto-changeover unit is installed', () => {
    const farm = { ...freshState, phaseId: 'farm' };
    expect(buildControlModel(farm, content, toVisualState(farm, content)).canQueue).toBe(false);
    const rota = content.automation.find((def) => def.behavior === 'auto-changeover');
    const equipped = {
      ...farm,
      automation: {
        [rota?.id ?? '']: { level: 1, enabled: true, threshold: 0, cooldownMs: 0 },
      },
    };
    expect(buildControlModel(equipped, content, toVisualState(equipped, content)).canQueue).toBe(
      true,
    );
  });

  it('sizes a filament purchase to what the money buys, capped at a restock', () => {
    const bench = {
      ...freshState,
      phaseId: 'bench',
      resources: { ...freshState.resources, money: 1 },
    };
    const poor = buildControlModel(bench, content, toVisualState(bench, content));
    expect(poor.buyFilament?.grams).toBe(20);
    expect(poor.buyFilament?.enabled).toBe(true);

    const broke = { ...bench, resources: { ...bench.resources, money: 0 } };
    expect(
      buildControlModel(broke, content, toVisualState(broke, content))?.buyFilament?.enabled,
    ).toBe(false);
  });

  it('only offers selling when there is something to sell', () => {
    expect(buildControlModel(freshState, content, freshVisual).canSell).toBe(false);
    const stocked = {
      ...freshState,
      resources: { ...freshState.resources, parts: 4 },
      partsValue: 4,
    };
    expect(buildControlModel(stocked, content, toVisualState(stocked, content)).canSell).toBe(true);
  });
});

describe('the selector hook', () => {
  function Probe({
    store,
    onRender,
  }: {
    store: ReturnType<typeof createGameStore>;
    onRender: () => void;
  }) {
    const parts = useGameSelector(store, (visual) => visual.ledger.parts);
    onRender();
    return <output data-testid="parts">{parts}</output>;
  }

  it('re-renders only when the selected value changes', () => {
    const store = createGameStore({ clock: createManualClock() });
    const onRender = vi.fn();
    render(<Probe store={store} onRender={onRender} />);
    const initial = onRender.mock.calls.length;

    act(() => {
      store.advanceWallClock(MS_PER_SECOND);
    });
    // Sim time moved, but `parts` did not, so the component stays put.
    expect(onRender.mock.calls.length).toBe(initial);
  });

  it('hands out a stable snapshot for derived objects', () => {
    const store = createGameStore({ clock: createManualClock() });
    function Derived() {
      const summary = useGameSelector(
        store,
        (visual) => ({ parts: visual.ledger.parts, money: visual.ledger.money }),
        (a, b) => a.parts === b.parts && a.money === b.money,
      );
      return <output data-testid="derived">{`${summary.parts}/${summary.money}`}</output>;
    }
    render(<Derived />);
    act(() => {
      store.advanceWallClock(MS_PER_SECOND);
    });
    expect(screen.getByTestId('derived').textContent).toBe('0/0');
  });

  it('follows the whole projection when asked for it', () => {
    const store = createGameStore({ clock: createManualClock() });
    function Whole() {
      const visual = useVisualState(store);
      return <output data-testid="time">{visual.simTimeMs}</output>;
    }
    render(<Whole />);
    act(() => {
      store.advanceWallClock(MS_PER_SECOND);
    });
    expect(screen.getByTestId('time').textContent).toBe('1000');
  });
});

describe('the engine loop', () => {
  it('turns wall-clock gaps into ticks, and long gaps into offline catch-up', () => {
    const clock = createManualClock(1000);
    const store = createGameStore({ clock });
    const onOffline = vi.fn();
    const loop = createGameLoop({ store, clock, onOffline });

    clock.advance(MS_PER_SECOND);
    loop.frame();
    expect(store.getState().simTimeMs).toBe(MS_PER_SECOND);
    expect(onOffline).not.toHaveBeenCalled();

    clock.advance(OFFLINE_THRESHOLD_MS);
    loop.frame();
    expect(onOffline).toHaveBeenCalledTimes(1);
  });

  it('never runs time backwards if the host clock does', () => {
    // A machine whose wall clock is corrected backwards (NTP, timezone, a
    // restored backup) must cost the player nothing, not throw.
    let now = 10_000;
    const clock = { nowMs: () => now };
    const store = createGameStore({ clock });
    const loop = createGameLoop({ store, clock });
    now = 4_000;
    expect(loop.frame()).toBe(0);
    expect(store.getState().simTimeMs).toBe(0);
    now = 5_000;
    loop.frame();
    expect(store.getState().simTimeMs).toBe(MS_PER_SECOND);
  });

  it('swallows the first frame after a restart rather than replaying the pause', () => {
    const clock = createManualClock(0);
    const store = createGameStore({ clock });
    const loop = createGameLoop({ store, clock, schedule: () => () => undefined });
    loop.start();
    loop.stop();
    clock.advance(5 * MS_PER_HOUR);
    loop.start();
    expect(loop.frame()).toBe(0);
    expect(store.getState().simTimeMs).toBe(0);
  });

  it('drives itself from an injected scheduler and stops cleanly', () => {
    const clock = createManualClock(0);
    const store = createGameStore({ clock });
    let pending: (() => void) | null = null;
    const loop = createGameLoop({
      store,
      clock,
      schedule: (callback) => {
        pending = callback;
        return () => {
          pending = null;
        };
      },
    });
    loop.start();
    expect(loop.isRunning()).toBe(true);
    clock.advance(MS_PER_SECOND);
    (pending as unknown as () => void)();
    expect(store.getState().simTimeMs).toBe(MS_PER_SECOND);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
    expect(pending).toBeNull();
  });

  it('starting twice does not double-schedule', () => {
    const clock = createManualClock(0);
    const store = createGameStore({ clock });
    const schedule = vi.fn(() => () => undefined);
    const loop = createGameLoop({ store, clock, schedule });
    loop.start();
    loop.start();
    expect(schedule).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});

describe('persistence', () => {
  it('reports an absent save rather than inventing one', async () => {
    expect(await readSave({ storage: createMemoryStorage() })).toEqual({ kind: 'absent' });
  });

  it('reports why an unreadable save could not be loaded', async () => {
    const storage = createMemoryStorage({ 'printhead/save': 'not json' });
    const outcome = await readSave({ storage });
    expect(outcome.kind).toBe('unreadable');
  });

  it('survives a storage layer that throws', async () => {
    const storage = createMemoryStorage();
    const broken = { ...storage, read: () => Promise.reject(new Error('quota')) };
    expect(await readSave({ storage: broken })).toEqual({
      kind: 'unreadable',
      message: 'quota',
    });
  });

  it('round-trips through the storage facade', async () => {
    const storage = createMemoryStorage();
    const state = createInitialState(content, { seed: 5 });
    await writeSave({ storage }, state, 1234);
    const outcome = await readSave({ storage });
    expect(outcome).toMatchObject({ kind: 'loaded', save: { state, savedAtMs: 1234 } });
  });
});

describe('autosave', () => {
  it('always persists the newest state, even when writes coalesce', async () => {
    const clock = createManualClock(0);
    const storage = createMemoryStorage();
    const store = createGameStore({ clock });
    const autosave = createAutosave({ store, clock, io: { storage }, intervalMs: 0 });

    void autosave.saveNow();
    clock.advance(5 * MS_PER_SECOND);
    store.advanceWallClock(5 * MS_PER_SECOND);
    await autosave.saveNow();
    await settle();

    const outcome = await readSave({ storage });
    expect(outcome).toMatchObject({
      kind: 'loaded',
      save: { savedAtMs: 5 * MS_PER_SECOND, state: { simTimeMs: 5 * MS_PER_SECOND } },
    });
  });

  it('reports a failing write instead of losing it silently', async () => {
    const clock = createManualClock(0);
    const storage = createMemoryStorage();
    const onError = vi.fn();
    const autosave = createAutosave({
      store: createGameStore({ clock }),
      clock,
      io: { storage: { ...storage, write: () => Promise.reject(new Error('full')) } },
      onError,
    });
    await autosave.saveNow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(autosave.lastSavedAtMs()).toBeNull();
  });

  it('writes nothing more once stopped', async () => {
    const clock = createManualClock(0);
    const storage = createMemoryStorage();
    const autosave = createAutosave({ store: createGameStore({ clock }), clock, io: { storage } });
    autosave.stop();
    await autosave.saveNow();
    expect(await readSave({ storage })).toEqual({ kind: 'absent' });
  });
});

describe('content hot-reload (spec §11)', () => {
  function fakeHot() {
    const handlers = new Map<string, (payload: unknown) => void>();
    return {
      channel: {
        on(event: string, callback: (payload: unknown) => void) {
          handlers.set(event, callback);
        },
      },
      emit(event: string, payload: unknown) {
        handlers.get(event)?.(payload);
      },
      has: (event: string) => handlers.has(event),
    };
  }

  it('swaps definitions into the running simulation', () => {
    const source = createMutableContentSource();
    const store = createGameStore({ contentSource: source, clock: createManualClock() });
    const hot = fakeHot();
    connectContentHotReload({ hot: hot.channel, source });

    const raw = JSON.parse(JSON.stringify(RAW_CONTENT)) as typeof RAW_CONTENT;
    (raw.pacing as { targetHours: number }).targetHours = 4;
    hot.emit(CONTENT_HMR_EVENT, raw);

    expect(store.getContent().pacing.targetHours).toBe(4);
    // The pace change is live: half the target hours, twice the ticks.
    expect(store.advanceWallClock(MS_PER_SECOND)).toBe(20);
  });

  it('keeps the last good set when the edit is invalid', () => {
    const source = createMutableContentSource();
    const hot = fakeHot();
    const onApplied = vi.fn();
    connectContentHotReload({ hot: hot.channel, source, onApplied });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    hot.emit(CONTENT_HMR_EVENT, { pacing: { targetHours: -1 } });

    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(source.get().pacing.targetHours).toBe(content.pacing.targetHours);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing at all outside a dev server', () => {
    const source = createMutableContentSource();
    expect(() => connectContentHotReload({ hot: undefined, source })).not.toThrow();
  });
});

describe('dev boot overrides', () => {
  it('reads a frozen clock and a paused boot out of the page', () => {
    expect(readBootOverrides({ [BOOT_OVERRIDES_KEY]: { nowMs: 5, paused: true } })).toEqual({
      nowMs: 5,
      paused: true,
    });
  });

  it('ignores anything it does not recognise', () => {
    expect(readBootOverrides({})).toEqual({});
    expect(readBootOverrides({ [BOOT_OVERRIDES_KEY]: 'nope' })).toEqual({});
    expect(readBootOverrides({ [BOOT_OVERRIDES_KEY]: { nowMs: 'soon' } })).toEqual({});
  });
});

describe('the store bridge', () => {
  it('replaces state wholesale when a save is loaded', () => {
    const store = createGameStore({
      contentSource: createStaticContentSource(),
      clock: createManualClock(),
    });
    store.advanceWallClock(MS_PER_SECOND);
    const listener = vi.fn();
    store.subscribe(listener);
    const fresh = createInitialState(content, { seed: 9 });
    store.replaceState(fresh);
    expect(store.getState()).toBe(fresh);
    expect(store.getVisualState().simTimeMs).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
