import type { OfflineSummary } from '@printhead/core';
import { Workshop } from '@printhead/renderer';
import { type ReactElement, useEffect, useState } from 'react';
import { Controls } from './controls.js';
import { useVisualState } from './hooks.js';
import { Hud } from './hud.js';
import { OfflineSummaryScreen } from './offline-summary.js';
import { AutomationPanel, MarketPanel, RecyclerPanel, UpgradePanel } from './panels.js';
import type { GameStore } from './store.js';

/**
 * The shell (spec §16). It renders `VisualState` and dispatches `Action`s —
 * that is the whole contract. Every rule it appears to know (which piece is
 * next, which buttons exist, what a phase allows) is read out of the projection
 * or the content, never decided here.
 */
export interface AppProps {
  readonly store: GameStore;
  /** Catch-up applied at boot, if the player was away (spec §7.4). */
  readonly initialOffline?: OfflineSummary | null;
  /** Later catch-ups — the tab came back after a long time in the background. */
  readonly subscribeOffline?: (listener: (summary: OfflineSummary) => void) => () => void;
  /** Shown when a save existed but could not be read. */
  readonly loadWarning?: string | null;
}

export function App({
  store,
  initialOffline = null,
  subscribeOffline,
  loadWarning = null,
}: AppProps): ReactElement {
  const visual = useVisualState(store);
  const content = store.getContent();
  const [offline, setOffline] = useState<OfflineSummary | null>(initialOffline);

  useEffect(() => subscribeOffline?.(setOffline), [subscribeOffline]);

  return (
    <main className="app">
      <header className="app__header">
        <h1>PRINTHEAD</h1>
        <p className="app__phase">
          {/* The id is the stable handle tests and tooling address; the name is
              what a player reads. Both are here; only one is visible. */}
          <span className="visually-hidden" data-testid="phase">
            {visual.phaseId}
          </span>
          <span className="app__phase-name" data-testid="phase-name">
            {visual.phaseName}
          </span>
        </p>
      </header>

      {loadWarning === null ? null : (
        <output className="app__warning" data-testid="load-warning">
          {loadWarning}
        </output>
      )}

      <Hud visual={visual} content={content} />
      <Workshop visual={visual} />
      <Controls store={store} visual={visual} content={content} />

      {/* The economy panels appear as the game unlocks them; each one hides
          itself while its mechanic is still locked (spec §6's reveal order). */}
      <div className="app__panels">
        <UpgradePanel store={store} visual={visual} />
        <MarketPanel store={store} visual={visual} />
        <RecyclerPanel store={store} visual={visual} />
        <AutomationPanel store={store} visual={visual} />
      </div>

      {offline === null ? null : (
        <OfflineSummaryScreen summary={offline} onDismiss={() => setOffline(null)} />
      )}
    </main>
  );
}
