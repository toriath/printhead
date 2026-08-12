import {
  type Content,
  type SlotQueueEntry,
  type VisualState,
  attachPiece,
  buyFilament,
  buyPrinter,
  sellParts,
  setSlotConfig,
  setSlotQueue,
  startPrint,
} from '@printhead/core';
import { type ReactElement, useState } from 'react';
import { buildControlModel } from './controls-model.js';
import { formatAmount, formatCountdown, formatGrams, formatMoney } from './format.js';
import type { GameStore } from './store.js';

/**
 * The control panel. Every button dispatches an `Action` and nothing else; the
 * reducer decides what actually happens (spec §15). What the panel decides is
 * only whether to *offer* the button — see `controls-model.ts`.
 *
 * Since M4 it is pointed at *a* bay rather than *the* bay: the rack can hold up
 * to four, and loading a configuration, feeding it and adding it to that bay's
 * rota are all the same decision aimed somewhere different.
 */

/** Batches one rota entry prints before the bay rotates on (spec §5B). */
const ROTA_BATCHES = 5;

export interface ControlsProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  readonly content: Content;
}

export function Controls({ store, visual, content }: ControlsProps): ReactElement {
  const [slotId, setSlotId] = useState<string | null>(null);
  const model = buildControlModel(store.getState(), content, visual, slotId ?? undefined);
  const slot = visual.slots.find((bay) => bay.slotId === model.slotId);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const chosenMaterial = materialId ?? slot?.materialId ?? model.materials[0]?.id ?? '';
  const chosenObject = objectId ?? slot?.objectId ?? model.objects[0]?.id ?? '';
  /** Append to the bay's rota, keeping what is already on it (spec §5B). */
  const appendToRota = (): void => {
    const existing: readonly SlotQueueEntry[] =
      slot?.queue.map((entry) => ({
        materialId: entry.materialId,
        objectId: entry.objectId,
        batches: entry.batches,
      })) ?? [];
    store.dispatch(
      setSlotQueue(model.slotId, [
        ...existing,
        { materialId: chosenMaterial, objectId: chosenObject, batches: ROTA_BATCHES },
      ]),
    );
  };

  return (
    <section className="controls" aria-label="controls">
      {model.attach === null ? null : (
        <button
          type="button"
          data-testid="attach"
          disabled={!model.attach.enabled}
          onClick={() => store.dispatch(attachPiece(model.attach?.pieceId ?? ''))}
        >
          {model.attach.enabled
            ? `Attach ${model.attach.label}`
            : `${model.attach.label} — ${formatCountdown(model.attach.cooldownMs)}`}
        </button>
      )}

      {model.materials.length === 0 || model.objects.length === 0 ? null : (
        <div className="controls__config">
          {model.slots.length > 1 ? (
            <label>
              <span className="visually-hidden">Bay</span>
              <select
                data-testid="slot"
                value={model.slotId}
                onChange={(event) => setSlotId(event.target.value)}
              >
                {model.slots.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span className="visually-hidden">Material</span>
            <select
              data-testid="material"
              value={chosenMaterial}
              onChange={(event) => setMaterialId(event.target.value)}
            >
              {model.materials.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Object</span>
            <select
              data-testid="object"
              value={chosenObject}
              onChange={(event) => setObjectId(event.target.value)}
            >
              {model.objects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            data-testid="configure"
            disabled={!model.canConfigure}
            onClick={() =>
              store.dispatch(setSlotConfig(model.slotId, chosenMaterial, chosenObject))
            }
          >
            Load slot
          </button>
          {model.canQueue ? (
            <button type="button" data-testid="queue-add" onClick={appendToRota}>
              Add to rota
            </button>
          ) : null}
        </div>
      )}

      <button
        type="button"
        data-testid="print"
        disabled={!model.canPrint}
        onClick={() => store.dispatch(startPrint(model.slotId))}
      >
        Print
      </button>

      <button
        type="button"
        data-testid="sell"
        disabled={!model.canSell}
        onClick={() => store.dispatch(sellParts())}
      >
        {`Sell ${formatAmount(visual.ledger.parts)} parts`}
      </button>

      {model.buyFilament === null ? null : (
        <button
          type="button"
          data-testid="buy-filament"
          disabled={!model.buyFilament.enabled}
          onClick={() =>
            store.dispatch(
              buyFilament(model.buyFilament?.materialId ?? '', model.buyFilament?.grams ?? 0),
            )
          }
        >
          {`Buy ${formatGrams(model.buyFilament.grams)} ${model.buyFilament.materialName} · ${formatMoney(
            model.buyFilament.cost,
          )}`}
        </button>
      )}

      {model.buyPrinter === null ? null : (
        <button
          type="button"
          data-testid="buy-printer"
          disabled={!model.buyPrinter.enabled}
          onClick={() =>
            store.dispatch(buyPrinter(model.buyPrinter?.printerId ?? '', model.slotId))
          }
        >
          {`Build ${model.buyPrinter.name} · ${formatAmount(model.buyPrinter.cost)} ${
            model.buyPrinter.resource
          }`}
        </button>
      )}
    </section>
  );
}
