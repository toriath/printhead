import {
  type VisualState,
  buyAutomation,
  buyFilament,
  buyUpgrade,
  recycleScrap,
  sellFilament,
  setAutomation,
} from '@printhead/core';
import type { ReactElement } from 'react';
import { price } from './afford.js';
import { contentOf, describeAutomation, describeUpgrade } from './describe.js';
import { formatAmount, formatGrams, formatMoney } from './format.js';
import type { GameStore } from './store.js';

/**
 * The M3 panels: the market board, the machine tree, the automation rack and
 * the recycler.
 *
 * Every one of them renders straight off `VisualState`. The projection already
 * resolved "is this unlocked?" and "can I afford it?" using the very functions
 * the reducer consults, so a button that looks live *is* live — the shell never
 * re-derives a rule and never disagrees with the simulation (spec §15).
 */
export interface PanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

/** One click of the market buys this many grams. */
const TRADE_GRAMS = 250;

function priceTrend(multiplier: number): string {
  if (multiplier > 1.05) {
    return 'dear';
  }
  if (multiplier < 0.95) {
    return 'cheap';
  }
  return 'steady';
}

/**
 * A gram is not always paid for in Money: the endgame's exotic feedstock costs
 * **Plates** (spec §3). The projection says which till, so the panel prices the
 * row in it and disables the button against the right balance rather than
 * assuming the ledger's Money is what matters.
 */
function balanceFor(visual: VisualState, resource: string): number {
  return resource === 'plates' ? visual.ledger.plates : visual.ledger.money;
}

function priceLabel(row: VisualState['market'][number]): string {
  return row.priceResource === 'money'
    ? formatMoney(row.buyPerGram)
    : `${formatAmount(row.buyPerGram)} ${row.priceResource}`;
}

export function MarketPanel({ store, visual }: PanelProps): ReactElement | null {
  const rows = visual.market.filter((row) => row.available);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="panel" aria-label="market" data-testid="market">
      <h2>Market</h2>
      <ul className="panel__list">
        {rows.map((row) => (
          <li key={row.materialId} className="panel__row">
            <span className="panel__name">
              {row.materialName}
              <span className="panel__note">
                {` ${priceLabel(row)}/g · ${priceTrend(row.priceMultiplier)}`}
              </span>
            </span>
            <span className="panel__actions">
              <button
                type="button"
                data-testid={`buy-${row.materialId}`}
                disabled={balanceFor(visual, row.priceResource) < row.buyPerGram * TRADE_GRAMS}
                onClick={() => store.dispatch(buyFilament(row.materialId, TRADE_GRAMS))}
              >
                {`Buy ${formatGrams(TRADE_GRAMS)}`}
              </button>
              {row.tradeable ? (
                <button
                  type="button"
                  data-testid={`sell-${row.materialId}`}
                  disabled={row.heldGrams < TRADE_GRAMS}
                  onClick={() => store.dispatch(sellFilament(row.materialId, TRADE_GRAMS))}
                >
                  {`Sell · ${formatMoney(row.sellPerGram * TRADE_GRAMS)}`}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UpgradePanel({ store, visual }: PanelProps): ReactElement | null {
  // Nodes nothing has unlocked yet stay off the screen entirely: the machine
  // tree should reveal itself, not taunt with a wall of grey. The Endgame Tree
  // is left out because it has a panel of its own — it is priced in Plates and
  // it is the last thing in the game, not another row of the machine list.
  const rows = visual.upgrades.filter(
    (row) => row.tree !== 'endgame' && (row.available || row.level > 0),
  );
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="panel" aria-label="machine tree" data-testid="upgrades">
      <h2>Machine</h2>
      <ul className="panel__list">
        {rows.map((row) => (
          <li key={row.upgradeId} className="panel__row">
            <span className="panel__name">
              {row.name}
              <span className="panel__note">
                {row.maxLevel > 1
                  ? ` ${row.level}/${row.maxLevel}`
                  : row.level > 0
                    ? ' installed'
                    : ''}
              </span>
              <span className="panel__desc">
                {describeUpgrade(contentOf(store), row.upgradeId)}
              </span>
            </span>
            {row.available ? (
              <button
                type="button"
                data-testid={`upgrade-${row.upgradeId}`}
                disabled={!row.affordable}
                {...price(visual, row.cost, row.costResource)}
                onClick={() => store.dispatch(buyUpgrade(row.upgradeId))}
              >
                {`${formatAmount(row.cost)} ${row.costResource}`}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AutomationPanel({ store, visual }: PanelProps): ReactElement | null {
  // Agents have their own tab (`agents.tsx`); this is the machinery.
  const rows = visual.automation.filter(
    (row) => row.agent === null && (row.available || row.installed),
  );
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="panel" aria-label="automation" data-testid="automation">
      <h2>Automation</h2>
      <ul className="panel__list">
        {rows.map((row) => (
          <li key={row.automationId} className="panel__row">
            <span className="panel__name">
              {row.name}
              {row.installed ? (
                // The threshold is the player's to set: an auto-seller stuck
                // at a few dozen Parts makes saving for anything impossible.
                <span className="threshold">
                  <button
                    type="button"
                    className="threshold__step"
                    aria-label={`Halve the ${row.name} threshold`}
                    data-testid={`threshold-down-${row.automationId}`}
                    onClick={() =>
                      store.dispatch(
                        setAutomation(row.automationId, {
                          threshold: Math.max(Math.floor(row.threshold / 2), 1),
                        }),
                      )
                    }
                  >
                    −
                  </button>
                  <span className="threshold__value">{`at ${formatAmount(row.threshold)}`}</span>
                  <button
                    type="button"
                    className="threshold__step"
                    aria-label={`Double the ${row.name} threshold`}
                    data-testid={`threshold-up-${row.automationId}`}
                    onClick={() =>
                      store.dispatch(
                        setAutomation(row.automationId, {
                          threshold: Math.max(row.threshold * 2, 1),
                        }),
                      )
                    }
                  >
                    +
                  </button>
                </span>
              ) : null}
              <span className="panel__desc">
                {describeAutomation(contentOf(store), row.automationId)}
              </span>
            </span>
            {row.installed ? (
              <button
                type="button"
                data-testid={`toggle-${row.automationId}`}
                onClick={() =>
                  store.dispatch(setAutomation(row.automationId, { enabled: !row.enabled }))
                }
              >
                {row.enabled ? 'On' : 'Off'}
              </button>
            ) : (
              <button
                type="button"
                data-testid={`automation-${row.automationId}`}
                disabled={!row.affordable}
                {...price(visual, row.cost, row.costResource)}
                onClick={() => store.dispatch(buyAutomation(row.automationId))}
              >
                {`${formatAmount(row.cost)} ${row.costResource}`}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RecyclerPanel({ store, visual }: PanelProps): ReactElement | null {
  const { recycler } = visual;
  if (!recycler.installed) {
    return null;
  }
  const target = recycler.yieldMaterialId;
  return (
    <section className="panel" aria-label="recycler" data-testid="recycler">
      <h2>Recycler</h2>
      <div className="panel__row">
        <span className="panel__name">
          {`${formatGrams(recycler.scrapGrams)} scrap`}
          <span className="panel__note">{` → ${formatGrams(recycler.yieldGrams)}`}</span>
        </span>
        <button
          type="button"
          data-testid="recycle"
          disabled={target === null || recycler.yieldGrams <= 0}
          onClick={() => store.dispatch(recycleScrap(target ?? '', null))}
        >
          Recycle
        </button>
      </div>
    </section>
  );
}
