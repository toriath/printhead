import { type VisualState, answerCommission } from '@printhead/core';
import type { ReactElement } from 'react';
import { loadAndPrint } from './controls.js';
import { formatMoney } from './format.js';
import { Spool } from './icons.js';
import type { GameStore } from './store.js';

/**
 * The order board. A client first knocks with a proposal — what they want,
 * what it pays, how long the job would get — and waits a little while for an
 * answer; take it on and the deadline starts, turn it down and they go. Taken
 * orders count matching prints automatically and show how far along they are.
 * Clients who keep getting their orders become regulars, and regulars pay
 * more: the stars are that loyalty.
 */
export interface CommissionsPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  /** The bay "Print this" loads the order into. */
  readonly slotId: string;
}

/** Regulars show at most this many stars. */
const MAX_STARS = 5;

function minutes(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function Stars({ count }: { count: number }): ReactElement | null {
  if (count <= 0) {
    return null;
  }
  return (
    <span className="order__stars" title={`${count} orders delivered before`}>
      {'★'.repeat(Math.min(count, MAX_STARS))}
    </span>
  );
}

export function CommissionsPanel({
  store,
  visual,
  slotId,
}: CommissionsPanelProps): ReactElement | null {
  const board = visual.commissions;
  if (!board.open) {
    return null;
  }
  const bay = visual.slots.find((slot) => slot.slotId === slotId);
  return (
    <section className="panel board" aria-label="orders" data-testid="commissions">
      <div className="board__head">
        <h2>Orders</h2>
        <span className="board__count">{`${board.completed} delivered`}</span>
      </div>
      {board.offers.length === 0 ? (
        <p className="panel__note">Nobody at the door right now.</p>
      ) : (
        <ul className="board__list">
          {board.offers.map((offer) => {
            const what = `${offer.count} ${offer.materialName} ${offer.objectName.toLowerCase()}s`;
            if (!offer.accepted) {
              return (
                <li
                  key={offer.serial}
                  className="order order--proposal"
                  data-testid={`proposal-${offer.serial}`}
                >
                  <div className="order__who">
                    <span className="order__knock" aria-hidden="true">
                      ✊
                    </span>
                    {offer.clientName}
                    <Stars count={offer.loyalty} />
                  </div>
                  <div className="order__what">
                    <Spool materialId={offer.materialId} size={20} />
                    {`wants ${what}`}
                  </div>
                  <div className="order__meta">
                    <span className="order__reward">{`pays ${formatMoney(offer.reward)}`}</span>
                  </div>
                  <div className="order__fuse" aria-hidden="true">
                    <span style={{ width: `${offer.timeLeft * 100}%` }} />
                  </div>
                  <div className="order__answer">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid={`accept-${offer.serial}`}
                      onClick={() => store.dispatch(answerCommission(offer.serial, true))}
                    >
                      Take it on
                    </button>
                    <button
                      type="button"
                      data-testid={`decline-${offer.serial}`}
                      onClick={() => store.dispatch(answerCommission(offer.serial, false))}
                    >
                      No thanks
                    </button>
                  </div>
                </li>
              );
            }
            const loaded = bay?.materialId === offer.materialId && bay?.objectId === offer.objectId;
            const urgent = offer.timeLeft < 0.25;
            return (
              <li key={offer.serial} className="order" data-testid={`order-${offer.serial}`}>
                <div className="order__who">
                  {offer.clientName}
                  <Stars count={offer.loyalty} />
                </div>
                <div className="order__what">
                  <Spool materialId={offer.materialId} size={20} />
                  {what}
                </div>
                <div className="order__bar" aria-hidden="true">
                  <span style={{ width: `${(offer.delivered / offer.count) * 100}%` }} />
                </div>
                <div className="order__meta">
                  <span>{`${Math.floor(offer.delivered)}/${offer.count}`}</span>
                  <span className={urgent ? 'order__time is-urgent' : 'order__time'}>
                    {minutes(offer.remainingMs)}
                  </span>
                  <span className="order__reward">{`pays ${formatMoney(offer.reward)}`}</span>
                </div>
                <button
                  type="button"
                  className={loaded ? 'order__go is-loaded' : 'order__go'}
                  disabled={loaded || bay === undefined || bay.printerCount === 0}
                  onClick={() => loadAndPrint(store, slotId, offer.materialId, offer.objectId)}
                >
                  {loaded ? 'Printing this' : 'Print this'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
