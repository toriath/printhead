import {
  type Content,
  type VisualState,
  attachPiece,
  buyFilament,
  buyPrinter,
  sellParts,
  setSlotConfig,
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
 */
export interface ControlsProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  readonly content: Content;
}

export function Controls({ store, visual, content }: ControlsProps): ReactElement {
  const model = buildControlModel(store.getState(), content, visual);
  const slot = visual.slots[0];
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const chosenMaterial = materialId ?? slot?.materialId ?? model.materials[0]?.id ?? '';
  const chosenObject = objectId ?? slot?.objectId ?? model.objects[0]?.id ?? '';

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
