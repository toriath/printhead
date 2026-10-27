import {
  type VisualState,
  buyMoneyPrinter,
  createDesign,
  prestige,
  sellProducts,
  setSlotDesign,
} from '@printhead/core';
import { type ReactElement, useState } from 'react';
import { price } from './afford.js';
import { formatAmount, formatMoney, formatPercent } from './format.js';
import { Modal } from './modal.js';
import type { GameStore } from './store.js';

/**
 * The M5 panels: the Design Studio (spec §5D) and the melt-down with the
 * presses it pays for (spec §5E).
 *
 * Like every other panel these render straight off `VisualState`. The
 * projection has already asked the very functions the reducer consults whether
 * a commission can be taken, whether the melt-down is on offer and what it
 * would pay, so a live-looking button *is* live and the shell never re-derives
 * a rule (spec §15).
 */
export interface MetaPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

/** Why a commission cannot be taken, in words a player can act on. */
const DESIGN_BLOCKED: Readonly<Record<string, string>> = {
  'already-owned': 'owned',
  'slot-busy': 'the bench is busy',
  'slot-full': 'no free design slot',
};

/**
 * Reasons that keep a Design off the screen entirely rather than greying it
 * out. A phase that has not arrived and a material the machine tree has not
 * opened are not *obstacles*, they are things the player has not met yet —
 * listing them would advertise the studio's whole catalogue from the bench
 * phase. Everything else is a real obstacle and is shown with its reason.
 */
const HIDDEN_REASONS: readonly string[] = ['locked', 'missing-prerequisite', 'unknown-target'];

const PRESTIGE_BLOCKED: Readonly<Record<string, string>> = {
  locked: 'not yet',
  'missing-prerequisite': 'design the Money Plate first',
  'not-worth-it': 'not worth melting down yet',
};

/** Bays a Design can be loaded into: staffed, and not mid-purge. */
function loadableBays(visual: VisualState): readonly string[] {
  return visual.slots
    .filter((slot) => slot.printerCount > 0 && !slot.changingOver)
    .map((slot) => slot.slotId);
}

export function StudioPanel({ store, visual }: MetaPanelProps): ReactElement | null {
  const { studio } = visual;
  // The studio reveals itself the moment anything in it is reachable — a
  // catalogue of grey rows before then would advertise a mechanic the player
  // has not met (the same rule every other panel follows).
  const rows = studio.designs.filter(
    (row) => row.owned || row.available || !HIDDEN_REASONS.includes(row.blockedReason ?? ''),
  );
  if (rows.length === 0 && studio.draftingDesignId === null) {
    return null;
  }
  const bays = loadableBays(visual);
  return (
    <section className="panel" aria-label="design studio" data-testid="studio">
      <h2>Studio</h2>
      <p className="panel__note" data-testid="studio-slots">
        {`${studio.designs.filter((row) => row.owned).length}/${studio.slots} design slots`}
      </p>
      {studio.draftingDesignId === null ? null : (
        <p className="panel__note" data-testid="studio-drafting">
          {`drafting ${studio.draftingName ?? studio.draftingDesignId} — ${formatPercent(
            studio.draftProgress,
          )}`}
        </p>
      )}
      <ul className="panel__list">
        {rows.map((row) => (
          <li key={row.designId} className="panel__row" data-testid={`design-${row.designId}`}>
            <span className="panel__name">
              {row.capstone ? `★ ${row.name}` : row.name}
              <span className="panel__note">
                {row.owned
                  ? ` lv ${row.level}/${row.maxLevel} · ${formatMoney(row.productValue)} each`
                  : ` ${formatMoney(row.productValue)} each`}
              </span>
            </span>
            <span className="panel__actions">
              {row.owned ? (
                bays.map((slotId) => (
                  <button
                    key={slotId}
                    type="button"
                    data-testid={`load-${row.designId}-${slotId}`}
                    onClick={() => store.dispatch(setSlotDesign(slotId, row.designId))}
                  >
                    {`Load ${slotId}`}
                  </button>
                ))
              ) : row.available ? (
                <button
                  type="button"
                  data-testid={`draft-${row.designId}`}
                  disabled={!row.affordable}
                  {...price(visual, row.cost, row.costResource)}
                  onClick={() => store.dispatch(createDesign(row.designId))}
                >
                  {`${formatAmount(row.cost)} ${row.costResource}`}
                </button>
              ) : (
                <span className="panel__note" data-testid={`design-blocked-${row.designId}`}>
                  {DESIGN_BLOCKED[row.blockedReason ?? ''] ?? row.blockedReason ?? 'unavailable'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {visual.ledger.products > 0 ? (
        <div className="panel__row">
          <span className="panel__name">
            {`${formatAmount(visual.ledger.products)} products`}
            <span className="panel__note">{' ready to sell'}</span>
          </span>
          <button
            type="button"
            data-testid="sell-products"
            onClick={() => store.dispatch(sellProducts(null))}
          >
            Sell all
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function PrestigePanel({ store, visual }: MetaPanelProps): ReactElement | null {
  const { prestige: melt } = visual;
  const [confirming, setConfirming] = useState(false);
  // Hidden until the melt-down is a real prospect: the capstone exists, or the
  // workshop has already been through one.
  const known = melt.available || melt.platesHeld > 0 || melt.runsCompleted > 0;
  if (!known) {
    return null;
  }
  return (
    <section className="panel" aria-label="prestige" data-testid="prestige">
      <h2>Melt-down</h2>
      <p className="panel__note" data-testid="prestige-plates">
        {`${formatAmount(melt.platesHeld)} plates · ${formatMoney(
          melt.moneyPerDesignSecond,
        )}/s printed · run ${melt.runsCompleted + 1}`}
      </p>
      <div className="panel__row">
        <span className="panel__name">
          {`Melt the workshop down for ${formatAmount(melt.platesOnOffer)} plates`}
          <span className="panel__note">{' — Designs survive'}</span>
        </span>
        <button
          type="button"
          data-testid="melt-down"
          disabled={!melt.available}
          onClick={() => setConfirming(true)}
        >
          {melt.available ? 'Melt down' : (PRESTIGE_BLOCKED[melt.blockedReason ?? ''] ?? 'not yet')}
        </button>
      </div>
      {/* The one button in the game that throws work away asks first. */}
      <Modal
        open={confirming}
        title="Melt the workshop down?"
        onClose={() => setConfirming(false)}
        testId="melt-down-dialog"
      >
        <div className="modal__columns">
          <div>
            <h3 className="modal__label">You keep</h3>
            <ul className="modal__list">
              <li>{`${formatAmount(melt.platesHeld + melt.platesOnOffer)} plates (+${formatAmount(melt.platesOnOffer)})`}</li>
              <li>Every Design and its level</li>
              <li>Presses and the endgame tree</li>
            </ul>
          </div>
          <div>
            <h3 className="modal__label">You lose</h3>
            <ul className="modal__list">
              <li>Money, parts and filament</li>
              <li>Printers, upgrades and automation</li>
            </ul>
          </div>
        </div>
        <div className="modal__actions">
          <button type="button" onClick={() => setConfirming(false)}>
            Keep printing
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="melt-down-confirm"
            onClick={() => {
              setConfirming(false);
              store.dispatch(prestige());
            }}
          >
            Melt it down
          </button>
        </div>
      </Modal>
      <ul className="panel__list">
        {visual.moneyPrinters
          .filter((press) => press.available || press.level > 0)
          .map((press) => (
            <li key={press.moneyPrinterId} className="panel__row">
              <span className="panel__name">
                {press.name}
                <span className="panel__note">{` ${press.level}/${press.maxLevel}`}</span>
              </span>
              {press.available ? (
                <button
                  type="button"
                  data-testid={`press-${press.moneyPrinterId}`}
                  disabled={!press.affordable}
                  {...price(visual, press.cost, press.costResource)}
                  onClick={() => store.dispatch(buyMoneyPrinter(press.moneyPrinterId))}
                >
                  {`${formatAmount(press.cost)} ${press.costResource}`}
                </button>
              ) : (
                <span className="panel__note">maxed</span>
              )}
            </li>
          ))}
      </ul>
    </section>
  );
}
