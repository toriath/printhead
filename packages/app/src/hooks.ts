import type { VisualState } from '@printhead/core';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { GameStore } from './store.js';

/**
 * Selector-hook subscription (spec §10: "React subscribes via selector hook").
 *
 * The store hands out a cached `VisualState` per state, so the common case is
 * a reference check. A selector that derives a *new* object every call would
 * still tear `useSyncExternalStore` apart, so the last result is memoised and
 * compared — `useSyncExternalStore` demands a snapshot that is stable while the
 * store has not changed, and this is what makes that true for derived values.
 */
export type Selector<T> = (visual: VisualState) => T;

export function useVisualState(store: GameStore): VisualState {
  return useGameSelector(store, identity);
}

const identity = (visual: VisualState): VisualState => visual;

export function useGameSelector<T>(
  store: GameStore,
  selector: Selector<T>,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  const equalRef = useRef(isEqual);
  selectorRef.current = selector;
  equalRef.current = isEqual;

  const cache = useRef<{ visual: VisualState; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const visual = store.getVisualState();
    const cached = cache.current;
    if (cached !== null && cached.visual === visual) {
      return cached.value;
    }
    const next = selectorRef.current(visual);
    if (cached !== null && equalRef.current(cached.value, next)) {
      cache.current = { visual, value: cached.value };
      return cached.value;
    }
    cache.current = { visual, value: next };
    return next;
  }, [store]);

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Shallow equality for selectors that build a small object per read. */
export function shallowEqual<T extends Record<string, unknown>>(a: T, b: T): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => Object.is(a[key], b[key]));
}
