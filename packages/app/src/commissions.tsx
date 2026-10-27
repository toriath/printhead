import type { VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import { loadAndPrint } from './controls.js';
import { formatMoney } from './format.js';
import { Spool } from './icons.js';
import type { GameStore } from './store.js';

/**
 * The commission board. Each order says who wants what, how much is already
 * delivered, how long is left and what it pays; "Print this" loads the order
 * into the bay and starts it in one tap. Deliveries count automatically.
 */
export interface CommissionsPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  /** The bay "Print this" loads the order into. */
  readonly slotId: string;
}

function minutes(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
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
    <section className="panel board" aria-label="commissions" data-testid="commissions">
      <div className="board__head">
        <h2>Commissions</h2>
        <span className="board__count">{`${board.completed} delivered`}</span>
      </div>
      {board.offers.length === 0 ? (
        <p className="panel__note">No orders right now. New ones arrive every minute or so.</p>
      ) : (
        <ul className="board__list">
          {board.offers.map((offer) => {
            const loaded = bay?.materialId === offer.materialId && bay?.objectId === offer.objectId;
            const urgent = offer.timeLeft < 0.25;
            return (
              <li key={offer.serial} className="order" data-testid={`order-${offer.serial}`}>
                <div className="order__who">{offer.clientName}</div>
                <div className="order__what">
                  <Spool materialId={offer.materialId} size={20} />
                  {`${offer.count} ${offer.materialName} ${offer.objectName.toLowerCase()}s`}
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
