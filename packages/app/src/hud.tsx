import type { Content, VisualState } from '@printhead/core';
import type { ReactElement } from 'react';
import { formatAmount, formatGrams, formatMoney, formatPercent } from './format.js';

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
}

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
}: {
  label: string;
  value: string;
  testId: string;
}): ReactElement {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

export function Hud({ visual, content }: HudProps): ReactElement {
  const stocked = content.materials.filter(
    (material) => (visual.ledger.filamentGrams[material.id] ?? 0) > 0,
  );
  return (
    <section className="hud" aria-label="workshop status">
      <dl className="hud__ledger" data-testid="ledger">
        <Stat label="Money" value={formatMoney(visual.ledger.money)} testId="money" />
        <Stat label="Parts" value={formatAmount(visual.ledger.parts)} testId="parts" />
        {/* Scrap only exists once a print has failed, and showing a permanent
            zero would advertise a mechanic the player has not met yet. */}
        {visual.ledger.scrap > 0 ? (
          <Stat label="Scrap" value={formatGrams(visual.ledger.scrap)} testId="scrap" />
        ) : null}
        {/* Products and Plates follow the same rule as Scrap: a permanent zero
            would advertise the Design Studio and prestige before they exist. */}
        {visual.ledger.products > 0 ? (
          <Stat label="Products" value={formatAmount(visual.ledger.products)} testId="products" />
        ) : null}
        {visual.ledger.plates > 0 ? (
          <Stat label="Plates" value={formatAmount(visual.ledger.plates)} testId="plates" />
        ) : null}
        {/* On-screen inflation (spec §6 phase 5). It appears the moment the
            economy starts devaluing itself and not a second before. */}
        {visual.inflation.active ? (
          <Stat
            label="Prices"
            value={`×${visual.inflation.multiplier.toFixed(2)}`}
            testId="inflation"
          />
        ) : null}
        {stocked.length === 0 ? (
          <Stat label="Filament" value={formatGrams(0)} testId="filament" />
        ) : (
          stocked.map((material) => (
            <Stat
              key={material.id}
              label={material.name}
              value={formatGrams(visual.ledger.filamentGrams[material.id] ?? 0)}
              testId={material.id === stocked[0]?.id ? 'filament' : `filament-${material.id}`}
            />
          ))
        )}
      </dl>
      <p className="hud__status" data-testid="print-status">
        {printStatus(visual)}
      </p>
    </section>
  );
}
