import {
  type SlotVisual,
  type VisualState,
  assignPrinter,
  buySlot,
  chooseFork,
  setSlotQueue,
} from '@printhead/core';
import type { ReactElement } from 'react';
import { formatAmount, formatPercent } from './format.js';
import type { GameStore } from './store.js';

/**
 * The fleet allocation panel (spec §4, §5B).
 *
 * The mid-game decision stops being "what am I printing?" and becomes "how do I
 * allocate my fleet across slots?", so this is where that decision is made: a
 * row per bay showing what it holds and what it is doing, buttons to walk
 * machines between bays, the next bay's price, and the once-per-run Farm or
 * Goliath commitment.
 *
 * Like every other panel it renders straight off `VisualState`. Whether a bay
 * has room, whether the next slot is available, whether a fork can be taken —
 * all of that was resolved by the projection using the functions the reducer
 * consults, so a live-looking button really is live (spec §15).
 */
export interface FleetPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

/** What a bay is doing right now, in one line a player can scan. */
export function bayStatus(slot: SlotVisual): string {
  if (slot.changingOver) {
    return `purging → ${slot.materialName ?? slot.materialId}`;
  }
  if (slot.running) {
    return `${slot.objectName ?? slot.objectId} ×${slot.batch} — ${formatPercent(slot.progress)}`;
  }
  if (slot.printerCount === 0) {
    return 'no machines';
  }
  return slot.materialId === null ? 'no config loaded' : 'idle';
}

function Rota({ slot }: { slot: SlotVisual }): ReactElement | null {
  if (slot.queue.length === 0) {
    return null;
  }
  return (
    <ol className="fleet__queue" data-testid={`rota-${slot.slotId}`}>
      {slot.queue.map((entry, index) => (
        <li
          key={`${entry.materialId}-${entry.objectId}-${index}`}
          className={
            entry.current ? 'fleet__queue-entry fleet__queue-entry--current' : 'fleet__queue-entry'
          }
          data-current={entry.current}
        >
          {`${entry.objectName} · ${entry.materialName} ×${entry.batches}`}
          {entry.current ? (
            <span className="panel__note">{` ${slot.queueBatches} done`}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * The Farm/Goliath fork (spec §5B). Shown as two cards rather than a dropdown
 * because it is the one decision in the game that cannot be taken back, and it
 * should feel like it.
 */
function ForkChoice({ store, visual }: FleetPanelProps): ReactElement | null {
  const offered = visual.forks.filter((fork) => fork.available || fork.chosen);
  if (offered.length === 0) {
    return null;
  }
  const committed = visual.forks.find((fork) => fork.chosen);
  return (
    <div className="fleet__fork" data-testid="fork">
      <h3>{committed === undefined ? 'Commit this run' : 'This run'}</h3>
      <ul className="panel__list">
        {offered.map((fork) => (
          <li key={fork.forkId} className="panel__row" data-chosen={fork.chosen}>
            <span className="panel__name">
              {fork.name}
              <span className="panel__note">{` ${fork.description}`}</span>
            </span>
            {fork.chosen ? (
              <span className="panel__note" data-testid={`fork-chosen-${fork.forkId}`}>
                committed
              </span>
            ) : (
              <button
                type="button"
                data-testid={`fork-${fork.forkId}`}
                disabled={!fork.affordable}
                onClick={() => store.dispatch(chooseFork(fork.forkId))}
              >
                {`${formatAmount(fork.cost)} ${fork.costResource}`}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FleetPanel({ store, visual }: FleetPanelProps): ReactElement | null {
  const { fleet, slotUnlock } = visual;
  // Before the rack means anything there is one bay and nothing to allocate;
  // the panel stays out of the way until the game is about fleets.
  if (fleet.slotsOwned <= 1 && slotUnlock?.available !== true && !visual.goliath) {
    return null;
  }
  const bays = visual.slots;
  const target = (from: SlotVisual): SlotVisual | undefined =>
    bays.find((bay) => bay.slotId !== from.slotId && bay.printerCount < bay.printerCapacity);

  return (
    <section className="panel fleet" aria-label="fleet" data-testid="fleet">
      <h2>Fleet</h2>
      <p className="panel__note" data-testid="fleet-summary">
        {`${formatAmount(fleet.printers)} machines · ${fleet.slotsActive}/${fleet.slotsMaximum} bays`}
      </p>

      <ul className="panel__list">
        {bays.map((slot) => {
          const to = target(slot);
          return (
            <li
              key={slot.slotId}
              className="panel__row fleet__bay"
              data-testid={`bay-${slot.slotId}`}
            >
              <span className="panel__name">
                {slot.materialName === null
                  ? slot.slotId
                  : `${slot.objectName} · ${slot.materialName}`}
                <span className="panel__note" data-testid={`bay-status-${slot.slotId}`}>
                  {` ${slot.printerCount}/${slot.printerCapacity} · ${bayStatus(slot)}`}
                </span>
                <Rota slot={slot} />
              </span>
              <span className="panel__actions">
                <button
                  type="button"
                  data-testid={`move-out-${slot.slotId}`}
                  disabled={slot.printerCount === 0 || to === undefined}
                  onClick={() => store.dispatch(assignPrinter(slot.slotId, to?.slotId ?? '', 1))}
                >
                  {to === undefined ? 'Move →' : `Move → ${to.slotId}`}
                </button>
                {slot.queue.length > 0 ? (
                  <button
                    type="button"
                    data-testid={`clear-rota-${slot.slotId}`}
                    onClick={() => store.dispatch(setSlotQueue(slot.slotId, []))}
                  >
                    Clear rota
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      {slotUnlock === null ? null : (
        <div className="panel__row" data-testid="slot-unlock">
          <span className="panel__name">
            {slotUnlock.name}
            {slotUnlock.blockedReason === null ? null : (
              <span className="panel__note" data-testid="slot-unlock-blocked">
                {` ${slotUnlock.blockedReason}`}
              </span>
            )}
          </span>
          <button
            type="button"
            data-testid="buy-slot"
            disabled={!slotUnlock.available || !slotUnlock.affordable}
            onClick={() => store.dispatch(buySlot(slotUnlock.unlockId))}
          >
            {`${formatAmount(slotUnlock.cost)} ${slotUnlock.costResource}`}
          </button>
        </div>
      )}

      <ForkChoice store={store} visual={visual} />
    </section>
  );
}
