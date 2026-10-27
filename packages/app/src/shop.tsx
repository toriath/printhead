import { type DomainEvent, type VisualState, setShopPrice } from '@printhead/core';
import { type CSSProperties, type ReactElement, useEffect, useRef, useState } from 'react';
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

interface Walker {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly hue: number;
  readonly hat: boolean;
  readonly served: boolean;
}

/** How long one visit takes on screen, there and back. */
const WALK_MS = 3600;
/** At most this many customers on the floor at once. */
const MAX_WALKERS = 5;

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * Customers you can see: each visit is a little figure that walks in from the
 * edge of the workshop floor to the stock pile, pauses, and walks out — with a
 * Part held high and a coin over its head, or empty-handed and glum.
 * Decoration only, driven by the shop's events.
 */
export function ShopFloor({
  store,
  stage,
}: {
  store: GameStore;
  stage: { readonly current: HTMLElement | null };
}): ReactElement {
  const [walkers, setWalkers] = useState<readonly Walker[]>([]);
  const nextId = useRef(0);
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const unsubscribe = store.onEvent((event: DomainEvent) => {
      if (event.type !== 'CUSTOMER_SERVED' && event.type !== 'CUSTOMER_LEFT') {
        return;
      }
      const box = stage.current?.getBoundingClientRect();
      const pile = stage.current?.querySelector('[data-pile]')?.getBoundingClientRect();
      if (box === undefined || box.width === 0) {
        return;
      }
      nextId.current += 1;
      const seed = hash(`${event.customerId}:${nextId.current}`);
      const walker: Walker = {
        id: nextId.current,
        from: box.width + 30,
        to: pile === undefined || pile.width === 0 ? box.width * 0.25 : pile.right - box.left + 18,
        hue: seed % 360,
        hat: seed % 3 === 0,
        served: event.type === 'CUSTOMER_SERVED',
      };
      setWalkers((current) => [...current, walker].slice(-MAX_WALKERS));
      timers.push(
        setTimeout(
          () => setWalkers((current) => current.filter((w) => w.id !== walker.id)),
          WALK_MS,
        ),
      );
    });
    return () => {
      unsubscribe();
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [store, stage]);
  return (
    <div className="shopfloor" aria-hidden="true">
      {walkers.map((walker) => (
        <span
          key={walker.id}
          className={walker.served ? 'customer is-served' : 'customer is-missed'}
          style={
            {
              '--from': `${walker.from}px`,
              '--to': `${walker.to}px`,
              '--hue': walker.hue,
              animationDuration: `${WALK_MS}ms`,
            } as CSSProperties
          }
        >
          <svg viewBox="0 0 24 40" className="customer__body" aria-hidden="true">
            {walker.hat ? (
              <rect x="5" y="0" width="14" height="5" rx="1.5" className="customer__hat" />
            ) : null}
            <circle cx="12" cy="9" r="5.5" className="customer__head" />
            <path d="M5 38V22a7 7 0 0 1 14 0v16" className="customer__coat" />
          </svg>
          <span className="customer__carry">{walker.served ? '◆' : '…'}</span>
        </span>
      ))}
    </div>
  );
}
