import { createMutableContentSource } from '@printhead/core';
import { type Clock, createManualClock, createWebPlatform } from '@printhead/platform';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';
import { bootGame } from './boot.js';
import { connectContentHotReload } from './dev/content-hot-reload.js';
import { installDevHooks, readBootOverrides } from './dev/hooks.js';

/**
 * Shell entry point (spec §16).
 *
 * Boot order matters: load the save, replay the time away through the same
 * reducer, *then* start the frame loop — otherwise the first frame's dt would
 * double-count the gap the offline catch-up just consumed.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root is missing from index.html');
}

// Dev builds may be handed a frozen clock so tests can drive time (spec §13).
const overrides = import.meta.env.DEV
  ? readBootOverrides(window as unknown as Record<string, unknown>)
  : {};
const manualClock = overrides.nowMs === undefined ? null : createManualClock(overrides.nowMs);
const clockOverride: { clock?: Clock } = manualClock === null ? {} : { clock: manualClock };

// A mutable source in dev so the Vite content watcher can swap defs live (§11).
const contentSource = createMutableContentSource();

const platform = createWebPlatform(clockOverride);

// Not top-level await: some build targets still refuse it, and the boot is
// short enough that a frame of empty page is invisible.
async function start(): Promise<void> {
  const game = await bootGame({
    platform,
    contentSource,
    autoStart: overrides.paused !== true,
  });

  if (import.meta.env.DEV) {
    connectContentHotReload({ hot: import.meta.hot, source: contentSource });
    installDevHooks({
      scope: window as unknown as Record<string, unknown>,
      game,
      ...(manualClock === null ? {} : { clock: manualClock }),
    });
  }

  const loadWarning =
    game.load.kind === 'unreadable'
      ? `Your save could not be read (${game.load.message}); starting a new workshop.`
      : null;

  createRoot(container as HTMLElement).render(
    <StrictMode>
      <App
        store={game.store}
        initialOffline={game.offline}
        subscribeOffline={game.subscribeOffline}
        loadWarning={loadWarning}
      />
    </StrictMode>,
  );
}

void start();
