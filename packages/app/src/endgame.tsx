import {
  type VisualState,
  buyUpgrade,
  newGamePlus,
  printSection,
  startFabricator,
} from '@printhead/core';
import { Ending } from '@printhead/renderer';
import { type ReactElement, useState } from 'react';
import { price } from './afford.js';
import { formatAmount, formatGrams, formatPercent } from './format.js';
import type { GameStore } from './store.js';

/**
 * The M6 panels: the Endgame Tree, the Universal Fabricator and the ending
 * (spec §5E, §6 phases 5–6, §7.3).
 *
 * Like every other panel these render straight off `VisualState`. The
 * projection has already asked the functions the reducer consults whether the
 * last print can start and why not, so a live-looking button *is* live.
 */
export interface EndgamePanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

/** Why the last print cannot start, in words a player can act on. */
const FABRICATOR_BLOCKED: Readonly<Record<string, string>> = {
  locked: 'blueprint required',
  'already-built': 'built',
  'slot-busy': 'printing',
  'wrong-fork': 'needs the giant printer',
  'slots-not-committed': 'commit every bay',
  'insufficient-resources': 'not enough feedstock',
};

/**
 * The Endgame Tree (spec §5E). It is the ordinary upgrade list filtered to the
 * one tree priced in Plates — the projection already carries `tree`, so the
 * panel needs no content table of its own.
 */
export function EndgamePanel({ store, visual }: EndgamePanelProps): ReactElement | null {
  const nodes = visual.upgrades.filter((node) => node.tree === 'endgame');
  const offered = nodes.filter((node) => node.available || node.level > 0);
  const { fabricator } = visual;
  if (offered.length === 0 && !fabricator.unlocked) {
    return null;
  }
  return (
    <section className="panel" aria-label="endgame" data-testid="endgame">
      <h2>Endgame</h2>
      <ul className="panel__list">
        {offered.map((node) => (
          <li key={node.upgradeId} className="panel__row" data-testid={`endgame-${node.upgradeId}`}>
            <span className="panel__name">
              {node.name}
              <span className="panel__note">{` ${node.level}/${node.maxLevel}`}</span>
            </span>
            {node.available ? (
              <button
                type="button"
                data-testid={`buy-${node.upgradeId}`}
                disabled={!node.affordable}
                {...price(visual, node.cost, node.costResource)}
                onClick={() => store.dispatch(buyUpgrade(node.upgradeId))}
              >
                {`${formatAmount(node.cost)} ${node.costResource}`}
              </button>
            ) : (
              <span className="panel__note">installed</span>
            )}
          </li>
        ))}
      </ul>
      {fabricator.unlocked ? <FabricatorRow store={store} visual={visual} /> : null}
    </section>
  );
}

/** The final print: the sections, the commitment, and the layer counter. */
function FabricatorRow({ store, visual }: EndgamePanelProps): ReactElement {
  const { fabricator } = visual;
  return (
    <div data-testid="fabricator-panel">
      <p className="panel__note" data-testid="fabricator-status">
        {fabricator.running
          ? `printing — layer ${fabricator.layer}/${fabricator.layers} · ${formatPercent(
              fabricator.progress,
            )}`
          : fabricator.complete
            ? 'printed'
            : `${formatGrams(fabricator.heldGrams)}/${formatGrams(
                fabricator.filamentGrams,
              )} feedstock · ${fabricator.committedPrinters}/${fabricator.requiredPrinters} machines committed`}
      </p>
      <div className="panel__row">
        <span className="panel__name">
          {`Sections ${fabricator.sections}/${fabricator.maxSections}`}
          <span className="panel__note">{' — each one shortens the build'}</span>
        </span>
        <button
          type="button"
          data-testid="print-section"
          disabled={!fabricator.sectionAvailable}
          onClick={() => store.dispatch(printSection())}
        >
          {fabricator.sectionRunning
            ? formatPercent(fabricator.sectionProgress)
            : `${formatAmount(fabricator.sectionCost)} ${fabricator.sectionCostResource}`}
        </button>
      </div>
      <div className="panel__row">
        <span className="panel__name">
          Universal Fabricator
          <span className="panel__note">{' — every bay, one print'}</span>
        </span>
        <button
          type="button"
          data-testid="start-fabricator"
          disabled={!fabricator.available}
          onClick={() => store.dispatch(startFabricator())}
        >
          {fabricator.available
            ? 'Print it'
            : (FABRICATOR_BLOCKED[fabricator.blockedReason ?? ''] ?? 'not yet')}
        </button>
      </div>
    </div>
  );
}

/**
 * The ending (spec §6 phase 6) and the post-game behind it. The sequence itself
 * is the renderer's — it is a picture, and the renderer is the pure function of
 * `VisualState` that draws pictures — so this is the frame around it plus the
 * one decision it offers: start again, on your own terms.
 */
export function EndingScreen({ store, visual }: EndgamePanelProps): ReactElement | null {
  const { ending } = visual;
  const [taken, setTaken] = useState<readonly string[]>([]);
  if (!ending.active) {
    return null;
  }
  const toggle = (id: string): void =>
    setTaken((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  return (
    <section className="ending" aria-label="the ending" data-testid="ending-screen">
      <Ending visual={visual} />
      {ending.newGamePlusAvailable ? (
        <div className="ending__ngplus" data-testid="new-game-plus">
          <h2>
            {ending.newGamePlusRun > 0 ? `Run ${ending.newGamePlusRun + 1}` : 'New Game Plus'}
          </h2>
          <p className="panel__note">Your Designs come with you. Everything else starts again.</p>
          <ul className="panel__list">
            {ending.modifiers.map((modifier) => (
              <li key={modifier.modifierId} className="panel__row">
                <label>
                  <input
                    type="checkbox"
                    data-testid={`ngplus-${modifier.modifierId}`}
                    checked={taken.includes(modifier.modifierId)}
                    onChange={() => toggle(modifier.modifierId)}
                  />
                  {` ${modifier.name}`}
                  <span className="panel__note">{` — ${modifier.description}`}</span>
                </label>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="start-new-game-plus"
            onClick={() => store.dispatch(newGamePlus(taken))}
          >
            Start again
          </button>
        </div>
      ) : null}
    </section>
  );
}
