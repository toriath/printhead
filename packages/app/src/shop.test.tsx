import { RAW_CONTENT, loadContent, visualFixture } from '@printhead/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommissionsPanel } from './commissions.js';
import { ShopPanel } from './shop.js';
import type { GameStore } from './store.js';

afterEach(cleanup);

const content = loadContent(RAW_CONTENT);
const showcase = visualFixture('showcase');
const fresh = visualFixture('fresh');

function stubStore(): { store: GameStore; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const store = {
    dispatch: (action: unknown) => dispatched.push(action),
    onEvent: () => () => undefined,
    getContent: () => content,
  } as unknown as GameStore;
  return { store, dispatched };
}

describe('the shop front', () => {
  it('stays hidden until the shop exists', () => {
    const { store } = stubStore();
    render(<ShopPanel store={store} visual={fresh} />);
    expect(screen.queryByTestId('shop')).toBeNull();
  });

  it('offers every price with what a Part fetches at it, and sets the one clicked', () => {
    const { store, dispatched } = stubStore();
    render(<ShopPanel store={store} visual={showcase} />);
    for (const level of showcase.shop.levels) {
      expect(screen.getByTestId(`shop-price-${level.id}`)).toBeDefined();
    }
    expect(screen.getByTestId('shop-price-fair').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('shop-price-premium'));
    expect(dispatched).toEqual([{ type: 'SET_SHOP_PRICE', priceLevelId: 'premium' }]);
  });
});

describe('the order board', () => {
  it('asks before taking a job on, and answers both ways', () => {
    const { store, dispatched } = stubStore();
    const slotId = showcase.slots[0]?.slotId ?? '';
    render(<CommissionsPanel store={store} visual={showcase} slotId={slotId} />);
    const proposal = showcase.commissions.offers.find((offer) => !offer.accepted);
    const taken = showcase.commissions.offers.find((offer) => offer.accepted);
    if (proposal === undefined || taken === undefined) {
      throw new Error('the showcase fixture needs a proposal and a taken order');
    }
    // A taken order shows progress and no answer buttons.
    expect(screen.getByTestId(`order-${taken.serial}`)).toBeDefined();
    expect(screen.queryByTestId(`accept-${taken.serial}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`accept-${proposal.serial}`));
    fireEvent.click(screen.getByTestId(`decline-${proposal.serial}`));
    expect(dispatched).toEqual([
      { type: 'ANSWER_COMMISSION', serial: proposal.serial, accept: true },
      { type: 'ANSWER_COMMISSION', serial: proposal.serial, accept: false },
    ]);
  });
});

describe('the agents', () => {
  it('hires an agent, and puts a hired one on or off duty', async () => {
    const { AgentsPanel } = await import('./agents.js');
    const { store, dispatched } = stubStore();
    const rows = content.automation
      .filter((def) => def.persona !== undefined)
      .map((def, index) => ({
        automationId: def.id,
        name: def.name,
        behavior: def.behavior,
        level: index === 0 ? 1 : 0,
        installed: index === 0,
        enabled: index === 0,
        threshold: def.defaultThreshold,
        available: true,
        affordable: true,
        cost: 10,
        costResource: 'money',
        agent: { name: def.persona?.name ?? '', role: def.persona?.role ?? '' },
      }));
    const [hired, free] = rows;
    if (hired === undefined || free === undefined) {
      throw new Error('expected two agents in content');
    }
    render(<AgentsPanel store={store} visual={{ ...showcase, automation: rows }} />);
    expect(screen.getByText(hired.agent.name)).toBeDefined();
    fireEvent.click(screen.getByTestId(`toggle-${hired.automationId}`));
    fireEvent.click(screen.getByTestId(`hire-${free.automationId}`));
    expect(dispatched).toEqual([
      { type: 'SET_AUTOMATION', automationId: hired.automationId, enabled: false },
      { type: 'BUY_AUTOMATION', automationId: free.automationId },
    ]);
  });
});
