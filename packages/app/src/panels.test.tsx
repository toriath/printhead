import { type VisualState, visualFixture } from '@printhead/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationPanel, MarketPanel, RecyclerPanel, UpgradePanel } from './panels.js';
import type { GameStore } from './store.js';

afterEach(cleanup);

/**
 * The panels are rendered against frozen `VisualState` fixtures with a stub
 * store, which is the whole point of the projection: the shell can be tested
 * without a simulation, because it has no rule of its own to test.
 */
function stubStore(): { store: GameStore; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const store = {
    dispatch: (action: unknown) => dispatched.push(action),
  } as unknown as GameStore;
  return { store, dispatched };
}

const fresh = visualFixture('fresh');
const economy = visualFixture('economy');
const showcase = visualFixture('showcase');

const withMoney = (visual: VisualState, money: number): VisualState => ({
  ...visual,
  ledger: { ...visual.ledger, money },
});

describe('MarketPanel', () => {
  it('shows only the materials the player has actually unlocked', () => {
    const { store } = stubStore();
    render(<MarketPanel store={store} visual={economy} />);
    const available = economy.market.filter((row) => row.available);
    expect(available.length).toBeGreaterThan(0);
    for (const row of economy.market) {
      const button = screen.queryByTestId(`buy-${row.materialId}`);
      expect(button === null, row.materialId).toBe(!row.available);
    }
  });

  it('offers a sell button only for materials somebody lists', () => {
    const { store } = stubStore();
    render(<MarketPanel store={store} visual={economy} />);
    expect(screen.queryByTestId('sell-pla')).toBeNull();
    expect(screen.queryByTestId('sell-petg')).not.toBeNull();
  });

  it('disables a buy the till cannot cover, and dispatches when it can', () => {
    const { store, dispatched } = stubStore();
    const { unmount } = render(<MarketPanel store={store} visual={withMoney(economy, 0)} />);
    expect(screen.getByTestId('buy-pla').hasAttribute('disabled')).toBe(true);
    unmount();

    render(<MarketPanel store={store} visual={withMoney(economy, 1_000_000)} />);
    fireEvent.click(screen.getByTestId('buy-pla'));
    expect(dispatched).toEqual([{ type: 'BUY_FILAMENT', materialId: 'pla', grams: 250 }]);
  });

  it('will not sell grams the player is not holding', () => {
    const { store } = stubStore();
    const empty: VisualState = {
      ...economy,
      market: economy.market.map((row) => ({ ...row, heldGrams: 0 })),
    };
    render(<MarketPanel store={store} visual={empty} />);
    expect(screen.getByTestId('sell-petg').hasAttribute('disabled')).toBe(true);
  });

  /**
   * A gram is not always paid for in Money (spec §3): the endgame's feedstock
   * costs Plates, so the row is priced in Plates and the button is disabled
   * against the Plate pile rather than against the till.
   */
  it('prices a Plate-bought material in Plates, and checks the right balance', () => {
    const { store } = stubStore();
    const endgame = visualFixture('endgame');
    render(<MarketPanel store={store} visual={endgame} />);
    const composite = endgame.market.find((row) => row.priceResource === 'plates');
    if (composite === undefined) {
      throw new Error('the endgame fixture must offer a Plate-priced material');
    }
    expect(screen.getByTestId(`buy-${composite.materialId}`).closest('li')?.textContent).toContain(
      'plates/g',
    );
    const broke = {
      ...endgame,
      ledger: { ...endgame.ledger, plates: 0, money: 1_000_000 },
    };
    cleanup();
    render(<MarketPanel store={store} visual={broke} />);
    expect((screen.getByTestId(`buy-${composite.materialId}`) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says whether a price is cheap, steady or dear', () => {
    const { store } = stubStore();
    const priced = (multiplier: number): VisualState => ({
      ...economy,
      market: economy.market.map((row) =>
        row.materialId === 'petg' ? { ...row, priceMultiplier: multiplier } : row,
      ),
    });
    for (const [multiplier, word] of [
      [0.6, 'cheap'],
      [1, 'steady'],
      [1.6, 'dear'],
    ] as const) {
      cleanup();
      render(<MarketPanel store={store} visual={priced(multiplier)} />);
      expect(screen.getByTestId('market').textContent).toContain(word);
    }
  });

  it('stays off screen entirely before any material is available', () => {
    const { store } = stubStore();
    const locked: VisualState = {
      ...fresh,
      market: fresh.market.map((row) => ({ ...row, available: false })),
    };
    const { container } = render(<MarketPanel store={store} visual={locked} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('UpgradePanel', () => {
  it('lists what is reachable and what is already bolted on, and nothing else', () => {
    const { store } = stubStore();
    render(<UpgradePanel store={store} visual={economy} />);
    for (const row of economy.upgrades) {
      const shown = screen.queryByText(row.name) !== null;
      expect(shown, row.upgradeId).toBe(row.available || row.level > 0);
    }
  });

  it('dispatches the purchase the projection said was affordable', () => {
    const { store, dispatched } = stubStore();
    const affordable: VisualState = {
      ...economy,
      upgrades: economy.upgrades.map((row) => ({ ...row, available: true, affordable: true })),
    };
    render(<UpgradePanel store={store} visual={affordable} />);
    fireEvent.click(screen.getByTestId('upgrade-hardened-nozzle'));
    expect(dispatched).toEqual([{ type: 'BUY_UPGRADE', upgradeId: 'hardened-nozzle' }]);
  });

  it('disables a node the ledger cannot pay for', () => {
    const { store } = stubStore();
    const broke: VisualState = {
      ...economy,
      upgrades: economy.upgrades.map((row) => ({ ...row, available: true, affordable: false })),
    };
    render(<UpgradePanel store={store} visual={broke} />);
    expect(screen.getByTestId('upgrade-hardened-nozzle').hasAttribute('disabled')).toBe(true);
  });

  it('shows the level on a multi-level node and "installed" on a one-shot', () => {
    const { store } = stubStore();
    render(<UpgradePanel store={store} visual={showcase} />);
    const text = screen.getByTestId('upgrades').textContent ?? '';
    expect(text).toContain('3/3');
    expect(text).toContain('installed');
  });

  it('leaves the Plate-priced endgame tree to its own panel (spec §5E)', () => {
    const { store } = stubStore();
    const endgame = visualFixture('endgame');
    render(<UpgradePanel store={store} visual={endgame} />);
    for (const node of endgame.upgrades.filter((row) => row.tree === 'endgame')) {
      expect(screen.queryByTestId(`buy-${node.upgradeId}`)).toBeNull();
    }
  });

  it('is invisible while the whole tree is locked', () => {
    const { store } = stubStore();
    const { container } = render(<UpgradePanel store={store} visual={fresh} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('AutomationPanel', () => {
  it('offers a purchase before it is installed and a switch afterwards', () => {
    const { store, dispatched } = stubStore();
    render(<AutomationPanel store={store} visual={economy} />);
    const installed = economy.automation.find((row) => row.installed);
    expect(installed).toBeDefined();
    if (installed === undefined) {
      return;
    }
    expect(screen.queryByTestId(`automation-${installed.automationId}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`toggle-${installed.automationId}`));
    expect(dispatched).toEqual([
      {
        type: 'SET_AUTOMATION',
        automationId: installed.automationId,
        enabled: !installed.enabled,
      },
    ]);
  });

  it('shows the threshold the machine is set to', () => {
    const { store } = stubStore();
    render(<AutomationPanel store={store} visual={economy} />);
    const installed = economy.automation.find((row) => row.installed);
    expect(screen.getByTestId('automation').textContent).toContain(String(installed?.threshold));
  });

  it('buys one that is available and affordable', () => {
    const { store, dispatched } = stubStore();
    const buyable: VisualState = {
      ...fresh,
      automation: fresh.automation.map((row) => ({ ...row, available: true, affordable: true })),
    };
    render(<AutomationPanel store={store} visual={buyable} />);
    fireEvent.click(screen.getByTestId('automation-auto-sell'));
    expect(dispatched).toEqual([{ type: 'BUY_AUTOMATION', automationId: 'auto-sell' }]);
  });

  it('is invisible before anything is unlocked', () => {
    const { store } = stubStore();
    const { container } = render(<AutomationPanel store={store} visual={fresh} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('RecyclerPanel', () => {
  it('appears only once the machine node is installed', () => {
    const { store } = stubStore();
    const { container, unmount } = render(<RecyclerPanel store={store} visual={fresh} />);
    expect(fresh.recycler.installed).toBe(false);
    expect(container.innerHTML).toBe('');
    unmount();

    render(<RecyclerPanel store={store} visual={economy} />);
    expect(economy.recycler.installed).toBe(true);
    expect(screen.queryByTestId('recycler')).not.toBeNull();
  });

  it('quotes what the bin would return, and recycles into the loaded material', () => {
    const { store, dispatched } = stubStore();
    render(<RecyclerPanel store={store} visual={showcase} />);
    expect(screen.getByTestId('recycler').textContent).toContain('420 g scrap');
    fireEvent.click(screen.getByTestId('recycle'));
    expect(dispatched).toEqual([
      { type: 'RECYCLE_SCRAP', materialId: showcase.recycler.yieldMaterialId, grams: null },
    ]);
  });

  it('disables the button when the bin would return nothing', () => {
    const { store } = stubStore();
    const empty: VisualState = {
      ...showcase,
      recycler: { ...showcase.recycler, scrapGrams: 0, yieldGrams: 0 },
    };
    render(<RecyclerPanel store={store} visual={empty} />);
    expect(screen.getByTestId('recycle').hasAttribute('disabled')).toBe(true);
  });
});

describe('every panel is a pure function of the projection', () => {
  it('renders identical markup for identical input', () => {
    const { store } = stubStore();
    const once = render(<MarketPanel store={store} visual={economy} />).container.innerHTML;
    cleanup();
    const twice = render(<MarketPanel store={store} visual={economy} />).container.innerHTML;
    expect(twice).toBe(once);
  });

  it('never reads the store while rendering — only on a click', () => {
    const getState = vi.fn();
    const store = { dispatch: () => undefined, getState } as unknown as GameStore;
    render(<UpgradePanel store={store} visual={economy} />);
    expect(getState).not.toHaveBeenCalled();
  });
});
