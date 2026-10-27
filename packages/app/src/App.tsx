import { overclockSlot } from '@printhead/core';
import { Workshop } from '@printhead/renderer';
import type { ReactElement } from 'react';
import { Controls } from './controls.js';
import { EndgamePanel, EndingScreen } from './endgame.js';
import { FleetPanel } from './fleet.js';
import { useVisualState } from './hooks.js';
import { Hud } from './hud.js';
import { LayerBanner, LayerTrack, PopupLayer, useJuice } from './juice.js';
import { PrestigePanel, StudioPanel } from './meta.js';
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
  /** Shown when a save existed but could not be read. */
  readonly loadWarning?: string | null;
}

export function App({ store, loadWarning = null }: AppProps): ReactElement {
  const visual = useVisualState(store);
  const content = store.getContent();
  const juice = useJuice(store);
  const bays = visual.goliath ? 1 : Math.max(visual.slotCapacity, visual.slots.length);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Printhead</h1>
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
      <LayerTrack content={content} phaseId={visual.phaseId} />
      {/* Alternating two identical animations restarts the shake on every
          failure without remounting the workshop. */}
      <div
        className={
          juice.shake === 0
            ? 'stage'
            : `stage ${juice.shake % 2 === 0 ? 'is-shake-a' : 'is-shake-b'}`
        }
        data-shake={juice.shake}
      >
        <Workshop
          visual={visual}
          flourishes={juice.flourishes}
          onSlotPress={(slotId) => store.dispatch(overclockSlot(slotId))}
        />
        <PopupLayer popups={juice.popups} bays={bays} />
      </div>
      <LayerBanner banner={juice.banner} />
      <Controls store={store} visual={visual} content={content} />

      {/* The economy panels appear as the game unlocks them; each one hides
          itself while its mechanic is still locked (spec §6's reveal order). */}
      <div className="app__panels">
        {/* The fleet allocator appears the moment the rack becomes a decision
            (spec §4): a second bay on sale, or more than one already owned. */}
        <FleetPanel store={store} visual={visual} />
        {/* The meta layer (spec §5D/§5E): each hides itself until the run can
            actually reach it. */}
        <StudioPanel store={store} visual={visual} />
        <PrestigePanel store={store} visual={visual} />
        <UpgradePanel store={store} visual={visual} />
        <MarketPanel store={store} visual={visual} />
        <RecyclerPanel store={store} visual={visual} />
        <AutomationPanel store={store} visual={visual} />
        {/* The endgame (spec §5E, §6 phases 5–6): the Plate-priced tree and
            the last print there is. Hidden until either is reachable. */}
        <EndgamePanel store={store} visual={visual} />
      </div>

      {/* The ending takes the screen when it arrives (spec §6 phase 6). */}
      <EndingScreen store={store} visual={visual} />
    </main>
  );
}
