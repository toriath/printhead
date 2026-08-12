import { attachPiece, sellParts, setSlotConfig, startPrint } from '@printhead/core';
import { Workshop } from '@printhead/renderer';
import { useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { GameStore } from './store.js';

/**
 * The shell (spec §16). It renders `VisualState` and dispatches Actions —
 * nothing else. Every rule it appears to know (which piece is next, which
 * buttons exist) is read out of the projection or the content, never decided
 * here: the reducer rejects anything the phase FSM does not allow.
 */
export interface AppProps {
  readonly store: GameStore;
}

export function useVisualState(store: GameStore) {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getVisualState(),
  );
}

const format = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

export function App({ store }: AppProps): ReactElement {
  const visual = useVisualState(store);
  const content = store.getContent();
  const firstSlot = content.start.slotIdPrefix;
  const slotId = `${firstSlot}-1`;
  const material = content.materials[0];
  const object = content.objects[0];
  const nextPieceId = visual.assembly.nextPieceId;

  return (
    <main>
      <header>
        <h1>PRINTHEAD</h1>
        <p data-testid="phase">{visual.phaseId}</p>
      </header>

      <dl data-testid="ledger">
        <dt>parts</dt>
        <dd data-testid="parts">{format(visual.ledger.parts)}</dd>
        <dt>money</dt>
        <dd data-testid="money">{format(visual.ledger.money)}</dd>
        <dt>filament</dt>
        <dd data-testid="filament">
          {format(visual.ledger.filamentGrams[material?.id ?? ''] ?? 0)}
        </dd>
      </dl>

      <Workshop visual={visual} />

      <section>
        {nextPieceId === null ? null : (
          <button
            type="button"
            data-testid="attach"
            onClick={() => store.dispatch(attachPiece(nextPieceId))}
          >
            {`Attach ${visual.assembly.nextPieceName ?? nextPieceId}`}
          </button>
        )}
        {material === undefined || object === undefined ? null : (
          <button
            type="button"
            data-testid="configure"
            onClick={() => store.dispatch(setSlotConfig(slotId, material.id, object.id))}
          >
            {`Load ${material.name} · ${object.name}`}
          </button>
        )}
        <button
          type="button"
          data-testid="print"
          onClick={() => store.dispatch(startPrint(slotId))}
        >
          Print
        </button>
        <button type="button" data-testid="sell" onClick={() => store.dispatch(sellParts())}>
          Sell parts
        </button>
      </section>
    </main>
  );
}
