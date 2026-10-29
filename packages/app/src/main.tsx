import { createMutableContentSource } from '@printhead/core';
import { type Clock, createManualClock, createWebPlatform } from '@printhead/platform';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './app.css';
import { bootGame } from './boot.js';
import { connectContentHotReload } from './dev/content-hot-reload.js';
import { installDevHooks, readBootOverrides } from './dev/hooks.js';
import { mountEditor } from './dev/mount-editor.js';
import { ReleaseBanner } from './release.js';

/**
 * Shell entry point (spec §16).
 *
 * Boot order matters: load the save, *then* start the frame loop, so the
 * first frame measures from boot rather than from when the save was written
 * (time away is not simulated, spec §7.4).
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

  /*
   * The dev Editor panel (spec §14) is loaded from a *dynamic* import inside a
   * `import.meta.env.DEV` branch. Vite replaces that flag with `false` in a
   * production build, so the branch — and with it the whole `@printhead/editor`
   * chunk — is eliminated rather than merely unreachable. `e2e/tests/
   * smoke.prod.spec.ts` checks the shipped bundle for its absence.
   */
  const editor = import.meta.env.DEV ? await mountEditor({ game, contentSource }) : null;

  createRoot(container as HTMLElement).render(
    <StrictMode>
      <App store={game.store} loadWarning={loadWarning} />
      <ReleaseBanner />
      {editor}
    </StrictMode>,
  );
}

void start();
