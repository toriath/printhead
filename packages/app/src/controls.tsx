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
import { price } from './afford.js';
import { type ControlModel, buildControlModel } from './controls-model.js';
import { formatAmount, formatCountdown, formatGrams, formatMoney } from './format.js';
import type { NextStepTarget } from './guide.js';
import { Icon, type IconName, Spool, spoolFill } from './icons.js';
import { markSeen, useNew } from './seen.js';
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
  /** The control model for the bay in focus (built by the shell). */
  readonly model?: ControlModel;
  /** Point the controls at another bay. */
  readonly onSelectSlot?: (slotId: string) => void;
  /** The control the guide is pointing at, highlighted. */
  readonly next?: NextStepTarget;
  /** The desktop shell assembles on its bench instead (see `assembly.tsx`). */
  readonly showAttach?: boolean;
  /** The bay in focus has stopped because its spool ran dry (see `starve.ts`). */
  readonly starved?: boolean;
}

/**
 * Load a bay and start it: loading is only ever the step before printing. A
 * bay that was already printing restarts by itself once its changeover purge
 * is done, so Print is only sent to a bay that is idle and ready now.
 */
export function loadAndPrint(
  store: GameStore,
  slotId: string,
  materialId: string,
  objectId: string,
): void {
  store.dispatch(setSlotConfig(slotId, materialId, objectId));
  const slot = store.getState().slots.find((bay) => bay.id === slotId);
  if (slot !== undefined && slot.run === null && slot.changeoverMs === 0) {
    store.dispatch(startPrint(slotId));
  }
}

/** "Resin (SLA)" fits a tile as "Resin". */
const shortName = (name: string): string =>
  name.replace(/\s*\(.*\)$/, '').replace(' feedstock', '');

/** Stock objects have their own glyphs; a player's Design gets the layers icon. */
function objectIcon(objectId: string): IconName {
  return objectId === 'bracket' || objectId === 'gearset' ? objectId : 'design';
}

/** A button the guide is pointing at gets a pulsing ring. */
const nextClass = (base: string, on: boolean): string => (on ? `${base} is-next` : base);

export function Controls({
  store,
  visual,
  content,
  model: given,
  onSelectSlot,
  next = null,
  showAttach = true,
  starved = false,
}: ControlsProps): ReactElement {
  const [localSlot, setLocalSlot] = useState<string | null>(null);
  const model =
    given ?? buildControlModel(store.getState(), content, visual, localSlot ?? undefined);
  const selectSlot = onSelectSlot ?? setLocalSlot;
  const slot = visual.slots.find((bay) => bay.slotId === model.slotId);
  // The starting kit is not a discovery; everything unlocked after it is.
  const fresh = useNew([
    ...model.materials.slice(1).map((option) => `material:${option.id}`),
    ...model.objects.slice(1).map((option) => `object:${option.id}`),
  ]);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [objectId, setObjectId] = useState<string | null>(null);
  const chosenMaterial = materialId ?? slot?.materialId ?? model.materials[0]?.id ?? '';
  const chosenObject = objectId ?? slot?.objectId ?? model.objects[0]?.id ?? '';
  const materialName = model.materials.find((m) => m.id === chosenMaterial)?.name ?? '';
  const objectName = model.objects.find((o) => o.id === chosenObject)?.name ?? '';
  const loaded = slot?.materialId === chosenMaterial && slot?.objectId === chosenObject;
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
  const status =
    slot === undefined || slot.printerCount === 0
      ? 'No printer yet'
      : starved
        ? `Out of ${slot.materialName ?? 'filament'}!`
        : slot.changingOver
          ? `Switching to ${slot.materialName ?? ''}…`
          : slot.running
            ? `Printing ${slot.objectName ?? ''} · ${Math.round(slot.progress * 100)}%`
            : slot.occupied
              ? 'Idle'
              : 'Nothing loaded';

  return (
    <section className="controls" aria-label="controls">
      {model.attach === null || !showAttach ? null : (
        <button
          type="button"
          className={nextClass('btn-primary btn-big controls__attach', next === 'attach')}
          data-testid="attach"
          data-key="A"
          disabled={!model.attach.enabled}
          onClick={() => store.dispatch(attachPiece(model.attach?.pieceId ?? ''))}
        >
          {model.attach.enabled
            ? `Attach ${model.attach.label}`
            : `${model.attach.label} — ${formatCountdown(model.attach.cooldownMs)}`}
        </button>
      )}

      {model.materials.length === 0 || model.objects.length === 0 ? null : (
        <div className="bay-card">
          <div className="bay-card__head">
            {model.slots.length > 1 ? (
              <div className="bay-card__tabs" role="tablist" aria-label="Bay">
                {model.slots.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={option.id === model.slotId}
                    className="bay-card__tab"
                    data-testid={`bay-tab-${index + 1}`}
                    data-key={`${index + 1}`}
                    onClick={() => selectSlot(option.id)}
                  >
                    {`Bay ${index + 1}`}
                  </button>
                ))}
                {/* Kept for keyboard users and the e2e suite: the same choice as a select. */}
                <label className="visually-hidden">
                  <span>Bay</span>
                  <select
                    data-testid="slot"
                    value={model.slotId}
                    onChange={(event) => selectSlot(event.target.value)}
                  >
                    {model.slots.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : (
              <span className="bay-card__title">Bay 1</span>
            )}
            <span
              className={starved ? 'bay-card__status is-alarm' : 'bay-card__status'}
              data-testid="bay-status"
            >
              {status}
            </span>
          </div>

          <fieldset className="picker">
            <legend className="field__label">Material</legend>
            <div className="picker__tiles">
              {model.materials.map((option) => {
                const grams = visual.ledger.filamentGrams[option.id] ?? 0;
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={option.id === chosenMaterial}
                    className={fresh.has(`material:${option.id}`) ? 'tile is-new' : 'tile'}
                    title={option.name}
                    onClick={() => {
                      setMaterialId(option.id);
                      markSeen(`material:${option.id}`);
                    }}
                  >
                    <Spool materialId={option.id} fill={spoolFill(grams)} size={40} />
                    <span className="tile__name">{shortName(option.name)}</span>
                    <span className="tile__meta">{formatGrams(grams)}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
          <fieldset className="picker">
            <legend className="field__label">Print</legend>
            <div className="picker__tiles">
              {model.objects.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={option.id === chosenObject}
                  className={fresh.has(`object:${option.id}`) ? 'tile is-new' : 'tile'}
                  onClick={() => {
                    setObjectId(option.id);
                    markSeen(`object:${option.id}`);
                  }}
                >
                  <Icon name={objectIcon(option.id)} size={30} className="tile__icon" />
                  <span className="tile__name">{option.name}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {starved && model.buyFilament !== null ? (
            <button
              type="button"
              className="btn-primary bay-card__restock"
              data-testid="restock"
              disabled={!model.buyFilament.enabled}
              onClick={() =>
                store.dispatch(
                  buyFilament(model.buyFilament?.materialId ?? '', model.buyFilament?.grams ?? 0),
                )
              }
            >
              <Spool materialId={model.buyFilament.materialId} fill={0} size={26} />
              {model.buyFilament.enabled
                ? `Restock: ${formatGrams(model.buyFilament.grams)} for ${formatMoney(model.buyFilament.cost)}`
                : 'Out of filament — sell parts to afford a spool'}
            </button>
          ) : null}

          <div className="bay-card__row bay-card__run">
            {loaded ? (
              <button
                type="button"
                className={nextClass('btn-primary', next === 'print')}
                data-testid="print"
                data-key="P"
                disabled={!model.canPrint}
                onClick={() => store.dispatch(startPrint(model.slotId))}
              >
                {slot?.running === true ? 'Printing…' : 'Print'}
              </button>
            ) : (
              <button
                type="button"
                className={nextClass('btn-primary', next === 'configure' || next === 'print')}
                data-testid="configure"
                data-key="L"
                disabled={!model.canConfigure}
                onClick={() => loadAndPrint(store, model.slotId, chosenMaterial, chosenObject)}
              >
                {`Load ${materialName} ${objectName.toLowerCase()} & print`}
              </button>
            )}
          </div>
          {model.canQueue ? (
            <button
              type="button"
              className="bay-card__rota"
              data-testid="queue-add"
              onClick={appendToRota}
            >
              {`Add ${materialName} ${objectName.toLowerCase()} to the rota`}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export interface ActionBarProps {
  readonly store: GameStore;
  readonly visual: VisualState;
  readonly model: ControlModel;
  readonly next?: NextStepTarget;
  /** A bay is stopped for want of filament: the restock button sounds the alarm. */
  readonly starved?: boolean;
  /** Buttons the player has not met yet stay hidden (see `reveal.ts`). */
  readonly reveal?: { readonly sell: boolean; readonly filament: boolean; readonly build: boolean };
}

const SHOW_ACTIONS = { sell: true, filament: true, build: true };

/** The workshop's money moves: sell, restock, build. Lives in the footer. */
export function ActionBar({
  store,
  visual,
  model,
  next = null,
  reveal = SHOW_ACTIONS,
  starved = false,
}: ActionBarProps): ReactElement {
  return (
    <div className="action-bar" aria-label="workshop actions">
      <button
        type="button"
        className={nextClass('btn-primary reveal', next === 'sell')}
        hidden={!reveal.sell}
        data-testid="sell"
        data-key="S"
        disabled={!model.canSell}
        onClick={() => store.dispatch(sellParts())}
      >
        <Icon name="sell" />
        {`Sell ${formatAmount(visual.ledger.parts)} parts`}
      </button>

      {model.buyFilament === null ? null : (
        <button
          type="button"
          className={`${nextClass(starved ? 'reveal is-alarm' : 'reveal', next === 'buy-filament')} ${
            price(visual, model.buyFilament.cost, 'money').className
          }`}
          style={price(visual, model.buyFilament.cost, 'money').style}
          hidden={!reveal.filament}
          data-testid="buy-filament"
          data-key="F"
          disabled={!model.buyFilament.enabled}
          onClick={() =>
            store.dispatch(
              buyFilament(model.buyFilament?.materialId ?? '', model.buyFilament?.grams ?? 0),
            )
          }
        >
          <Spool materialId={model.buyFilament.materialId} size={20} />
          {`Buy ${formatGrams(model.buyFilament.grams)} ${model.buyFilament.materialName} · ${formatMoney(
            model.buyFilament.cost,
          )}`}
        </button>
      )}

      {model.buyPrinter === null ? null : (
        <button
          type="button"
          className={`${nextClass('reveal', next === 'spend' && model.buyPrinter.enabled)} ${
            price(visual, model.buyPrinter.cost, model.buyPrinter.resource).className
          }`}
          style={price(visual, model.buyPrinter.cost, model.buyPrinter.resource).style}
          hidden={!reveal.build}
          data-testid="buy-printer"
          data-key="B"
          disabled={!model.buyPrinter.enabled}
          onClick={() =>
            store.dispatch(buyPrinter(model.buyPrinter?.printerId ?? '', model.slotId))
          }
        >
          <Icon name="printer" />
          {`Build ${model.buyPrinter.name} · ${formatAmount(model.buyPrinter.cost)} ${
            model.buyPrinter.resource
          }`}
        </button>
      )}
    </div>
  );
}
