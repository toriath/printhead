/**
 * Lifecycle facade (spec §15, §17). Browsers throttle or suspend a background
 * tab, and iOS freezes a web view outright, so "how much time really passed"
 * is a *platform* question. The app asks it here and hands the answer to
 * `core`'s offline catch-up, which is the same code path as normal play.
 */
export type Unsubscribe = () => void;

export interface Lifecycle {
  readonly id: string;
  /** True while the game is on screen. */
  isVisible(): boolean;
  /** Fired when the game comes back to the foreground. */
  onForeground(listener: () => void): Unsubscribe;
  /** Fired when the game is hidden — the moment to autosave. */
  onBackground(listener: () => void): Unsubscribe;
}

export interface ManualLifecycle extends Lifecycle {
  /** Test/E2E driver: flip visibility and notify. */
  setVisible(visible: boolean): void;
}

export function createManualLifecycle(visible = true): ManualLifecycle {
  let current = visible;
  const foreground = new Set<() => void>();
  const background = new Set<() => void>();
  const subscribe = (set: Set<() => void>, listener: () => void): Unsubscribe => {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };
  return {
    id: 'manual',
    isVisible: () => current,
    onForeground: (listener) => subscribe(foreground, listener),
    onBackground: (listener) => subscribe(background, listener),
    setVisible(next) {
      if (next === current) {
        return;
      }
      current = next;
      for (const listener of next ? foreground : background) {
        listener();
      }
    },
  };
}

/** Minimal shape of the document the web lifecycle needs — keeps it testable. */
export interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * `visibilitychange` covers tab switches and iOS suspension; `pagehide` covers
 * the case where the browser discards the page without ever hiding it, which is
 * the one that silently loses a save if nobody listens for it.
 */
export function createWebLifecycle(doc: VisibilityDocument | undefined): Lifecycle {
  if (doc === undefined) {
    return createManualLifecycle(true);
  }
  const isVisible = (): boolean => doc.visibilityState !== 'hidden';
  const listen = (listener: () => void, wantVisible: boolean): Unsubscribe => {
    const onVisibility = (): void => {
      if (isVisible() === wantVisible) {
        listener();
      }
    };
    doc.addEventListener('visibilitychange', onVisibility);
    if (!wantVisible) {
      doc.addEventListener('pagehide', listener);
    }
    return () => {
      doc.removeEventListener('visibilitychange', onVisibility);
      if (!wantVisible) {
        doc.removeEventListener('pagehide', listener);
      }
    };
  };
  return {
    id: 'web',
    isVisible,
    onForeground: (listener) => listen(listener, true),
    onBackground: (listener) => listen(listener, false),
  };
}
