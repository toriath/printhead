import {
  RAW_CONTENT,
  advancePhase,
  createMutableContentSource,
  createStaticContentSource,
} from '@printhead/core';
import { createManualClock } from '@printhead/platform';
import { describe, expect, it } from 'vitest';
import { createGameStore } from './store.js';

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('game store bridge', () => {
  it('turns wall-clock time into fixed ticks', () => {
    const store = createGameStore({ clock: createManualClock() });
    expect(store.advanceWallClock(1000)).toBe(10);
    expect(store.getState().tickCount).toBe(10);
    expect(store.getState().simTimeMs).toBe(1000);
  });

  it('respects the content pace: 4 h target ticks twice as fast', () => {
    const raw = deepClone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 4;
    const fast = createGameStore({
      contentSource: createStaticContentSource(raw),
      clock: createManualClock(),
    });
    const normal = createGameStore({ clock: createManualClock() });
    expect(fast.advanceWallClock(1000)).toBe(normal.advanceWallClock(1000) * 2);
  });

  it('notifies subscribers and hands out a stable visual snapshot', () => {
    const store = createGameStore({ clock: createManualClock() });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    const before = store.getVisualState();
    expect(store.getVisualState()).toBe(before);
    store.advanceWallClock(1000);
    expect(notifications).toBe(1);
    expect(store.getVisualState()).not.toBe(before);
    unsubscribe();
    store.advanceWallClock(1000);
    expect(notifications).toBe(1);
  });

  it('does not notify when no tick boundary was crossed', () => {
    const store = createGameStore({ clock: createManualClock() });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    expect(store.advanceWallClock(50)).toBe(0);
    expect(notifications).toBe(0);
  });

  it('dispatches domain actions through the same reducer', () => {
    const store = createGameStore({ clock: createManualClock() });
    store.dispatch(advancePhase());
    expect(store.getState().phaseId).toBe('bench');
    expect(store.getVisualState().phaseId).toBe('bench');
  });

  it('picks up hot-reloaded content (pace changes live)', () => {
    const source = createMutableContentSource();
    const store = createGameStore({ contentSource: source, clock: createManualClock() });
    expect(store.advanceWallClock(1000)).toBe(10);
    const raw = deepClone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 4;
    expect(source.replace(raw).ok).toBe(true);
    expect(store.advanceWallClock(1000)).toBe(20);
  });
});
