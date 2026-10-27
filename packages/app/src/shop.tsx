import { type DomainEvent, type VisualState, setShopPrice } from '@printhead/core';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { formatMoney } from './format.js';
import type { GameStore } from './store.js';

/**
 * The shop front. The counter shows who just walked in and what they did —
 * bought a handful of Parts, or found the shelf bare and left — and the four
 * prices say exactly what they trade: what a Part fetches over the counter,
 * against how many people come in. Reputation is the stars.
 */
export interface ShopPanelProps {
  readonly store: GameStore;
  readonly visual: VisualState;
}

interface Visit {
  readonly id: number;
  readonly name: string;
  readonly served: boolean;
  readonly parts: number;
  readonly money: number;
}

/** The counter remembers this many visits. */
const COUNTER_LENGTH = 4;
const STARS = 5;

/** The last few customers, newest first, read off the event stream. */
function useCounter(store: GameStore): readonly Visit[] {
  const [visits, setVisits] = useState<readonly Visit[]>([]);
  const nextId = useRef(0);
  useEffect(
    () =>
      store.onEvent((event: DomainEvent) => {
        if (event.type !== 'CUSTOMER_SERVED' && event.type !== 'CUSTOMER_LEFT') {
          return;
        }
        const name =
          store.getContent().shop.customers.find((c) => c.id === event.customerId)?.name ??
          'Someone';
        nextId.current += 1;
        const visit: Visit =
          event.type === 'CUSTOMER_SERVED'
            ? { id: nextId.current, name, served: true, parts: event.parts, money: event.money }
            : { id: nextId.current, name, served: false, parts: event.wanted, money: 0 };
        setVisits((current) => [visit, ...current].slice(0, COUNTER_LENGTH));
      }),
    [store],
  );
  return visits;
}

export function ShopPanel({ store, visual }: ShopPanelProps): ReactElement | null {
  const visits = useCounter(store);
  const { shop } = visual;
  if (!shop.open) {
    return null;
  }
  const shut = shop.levels.find((level) => level.id === shop.priceLevelId)?.demandMultiplier === 0;
  const lit = Math.round(shop.reputation * STARS);
  return (
    <section
      className={shut ? 'panel shopfront is-shut' : 'panel shopfront'}
      aria-label="shop front"
      data-testid="shop"
    >
      <div className="board__head">
        <h2>Shop front</h2>
        <span
          className="shopfront__stars"
          title={`Reputation ${Math.round(shop.reputation * 100)}%`}
        >
          {'★'.repeat(lit)}
          <span className="shopfront__stars-off">{'★'.repeat(STARS - lit)}</span>
        </span>
      </div>
      <fieldset className="shopfront__prices">
        <legend className="field__label">Price</legend>
        {shop.levels.map((level) => (
          <button
            key={level.id}
            type="button"
            aria-pressed={level.id === shop.priceLevelId}
            className={
              level.demandMultiplier === 0 ? 'shopfront__price is-closed' : 'shopfront__price'
            }
            data-testid={`shop-price-${level.id}`}
            onClick={() => store.dispatch(setShopPrice(level.id))}
          >
            <span className="shopfront__price-name">{level.name}</span>
            {level.demandMultiplier === 0 ? null : (
              <span className="shopfront__price-each">
                {`${formatMoney(shop.wholesalePrice * level.priceMultiplier)} ea`}
              </span>
            )}
          </button>
        ))}
      </fieldset>
      <ol className="shopfront__counter" aria-live="polite">
        {shut ? (
          <li className="shopfront__visit is-quiet">The sign says CLOSED.</li>
        ) : visits.length === 0 ? (
          <li className="shopfront__visit is-quiet">The bell has not rung yet.</li>
        ) : (
          visits.map((visit) => (
            <li
              key={visit.id}
              className={visit.served ? 'shopfront__visit' : 'shopfront__visit is-missed'}
            >
              <span className="shopfront__who">{visit.name}</span>
              <span className="shopfront__did">
                {visit.served
                  ? `bought ${visit.parts} · ${formatMoney(visit.money)}`
                  : `wanted ${visit.parts}, shelf empty`}
              </span>
            </li>
          ))
        )}
      </ol>
      <p className="shopfront__tally">{`${shop.served} served · ${shop.missed} turned away`}</p>
    </section>
  );
}
