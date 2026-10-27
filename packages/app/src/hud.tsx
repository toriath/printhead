import type { Content, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import { RollingMoney } from './casino.js';
import { formatAmount, formatGrams, formatMoney, formatPercent } from './format.js';
import { Icon, type IconName, Spool, spoolFill } from './icons.js';

/**
 * The HUD (spec §16): Money, Parts, Filament and what the machines are doing.
 *
 * Everything it shows comes from `VisualState`; the only thing it reads from
 * content is the display *name* of a material, because the projection carries
 * ids and a player should see "PLA", not "pla".
 */
export interface HudProps {
  readonly visual: VisualState;
  readonly content: Content;
  /** The desktop shell shows spools on their own shelf instead. */
  readonly showFilament?: boolean;
  /** Ledger lines the player has not met yet stay hidden (see `reveal.ts`). */
  readonly reveal?: { readonly money: boolean; readonly parts: boolean };
}

const SHOW_ALL = { money: true, parts: true };

export function printStatus(visual: VisualState): string {
  const running = visual.slots.filter((slot) => slot.running);
  if (running.length === 0) {
    const staffed = visual.slots.some((slot) => slot.printerCount > 0);
    return staffed ? 'idle' : 'no printer';
  }
  const first = running[0];
  if (first === undefined) {
    return 'idle';
  }
  const batch = first.batch > 1 ? ` ×${first.batch}` : '';
  const more = running.length > 1 ? ` (+${running.length - 1} more)` : '';
  return `printing ${first.objectName ?? first.objectId}${batch} — ${formatPercent(first.progress)}${more}`;
}

function Stat({
  label,
  value,
  testId,
  icon,
}: {
  label: string;
  value: string;
  testId: string;
  icon: IconName;
}): ReactElement {
  return (
    <div className={`stat stat--${icon}`}>
      <dt>
        <Icon name={icon} size={14} />
        {label}
      </dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

/**
 * Spec §6 phase 6: once the last print lands, "the numbers fade to ∞". The
 * projection says when (`ending.infinite`) — the HUD does not decide that a
 * number has become absurd, it is told.
 */
const INFINITY = '∞';

export function Hud({
  visual,
  content,
  showFilament = true,
  reveal = SHOW_ALL,
}: HudProps): ReactElement {
  const ended = visual.ending.infinite;
  return (
    <section className="hud" aria-label="workshop status">
      <dl className="hud__ledger" data-testid="ledger">
        <div className="stat stat--money reveal" hidden={!reveal.money}>
          <dt>
            <Icon name="money" size={14} />
            Money
          </dt>
          <dd>
            {ended ? null : <RollingMoney value={visual.ledger.money} />}
            <span className={ended ? undefined : 'visually-hidden'} data-testid="money">
              {ended ? INFINITY : formatMoney(visual.ledger.money)}
            </span>
          </dd>
        </div>
        <div className="stat reveal" hidden={!reveal.parts}>
          <dt>
            <Icon name="parts" size={14} />
            Parts
          </dt>
          <dd data-testid="parts">{ended ? INFINITY : formatAmount(visual.ledger.parts)}</dd>
        </div>
        {/* Scrap only exists once a print has failed, and showing a permanent
            zero would advertise a mechanic the player has not met yet. */}
        {visual.ledger.scrap > 0 ? (
          <Stat
            label="Scrap"
            icon="scrap"
            value={formatGrams(visual.ledger.scrap)}
            testId="scrap"
          />
        ) : null}
        {/* Products and Plates follow the same rule as Scrap: a permanent zero
            would advertise the Design Studio and prestige before they exist. */}
        {visual.ledger.products > 0 ? (
          <Stat
            label="Products"
            icon="products"
            value={formatAmount(visual.ledger.products)}
            testId="products"
          />
        ) : null}
        {visual.ledger.plates > 0 ? (
          <Stat
            label="Plates"
            icon="plates"
            value={formatAmount(visual.ledger.plates)}
            testId="plates"
          />
        ) : null}
        {/* On-screen inflation (spec §6 phase 5). It appears the moment the
            economy starts devaluing itself and not a second before. */}
        {visual.inflation.active ? (
          <Stat
            label="Prices"
            icon="prices"
            value={`×${visual.inflation.multiplier.toFixed(2)}`}
            testId="inflation"
          />
        ) : null}
        {showFilament ? <FilamentStat visual={visual} content={content} /> : null}
      </dl>
      <p className="hud__status" data-testid="print-status">
        {printStatus(visual)}
      </p>
    </section>
  );
}

/** Every stocked spool, one swatch and weight each. */
export function FilamentStat({ visual, content }: HudProps): ReactElement {
  const stocked = content.materials.filter(
    (material) => (visual.ledger.filamentGrams[material.id] ?? 0) > 0,
  );
  return (
    <div className="stat stat--filament">
      <dt>
        <Icon name="filament" size={14} />
        Filament
      </dt>
      <dd>
        {stocked.length === 0 ? (
          <span data-testid="filament">{formatGrams(0)}</span>
        ) : (
          stocked.map((material) => (
            <span key={material.id} className="stock">
              <Spool
                materialId={material.id}
                fill={spoolFill(visual.ledger.filamentGrams[material.id] ?? 0)}
                size={26}
              />
              <span className="stock__name">{material.name}</span>
              <span
                className="stock__grams"
                data-testid={
                  material.id === stocked[0]?.id ? 'filament' : `filament-${material.id}`
                }
              >
                {formatGrams(visual.ledger.filamentGrams[material.id] ?? 0)}
              </span>
            </span>
          ))
        )}
      </dd>
    </div>
  );
}

/** The spool shelf: filament stock beside the bay that spends it. */
export function SpoolShelf({ visual, content }: HudProps): ReactElement {
  return (
    <dl className="shelf" aria-label="filament stock">
      <FilamentStat visual={visual} content={content} />
    </dl>
  );
}
