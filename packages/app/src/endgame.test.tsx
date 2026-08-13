import { RAW_CONTENT, loadContent, visualFixture } from '@printhead/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EndgamePanel, EndingScreen } from './endgame.js';
import { Hud } from './hud.js';
import type { GameStore } from './store.js';

const content = loadContent(RAW_CONTENT);

afterEach(cleanup);

/**
 * The endgame panels, rendered against frozen fixtures with a stub store —
 * no simulation, because a panel that needed one would mean the shell had
 * grown a rule of its own (spec §15).
 */
function stubStore(): { store: GameStore; dispatched: { type: string }[] } {
  const dispatched: { type: string }[] = [];
  const store = {
    dispatch: (action: { type: string }) => dispatched.push(action),
  } as unknown as GameStore;
  return { store, dispatched };
}

const printing = visualFixture('printing');
const endgame = visualFixture('endgame');
const fabricating = visualFixture('fabricator');
const ending = visualFixture('ending');

describe('EndgamePanel (spec §5E)', () => {
  it('stays off the screen until a Plate can buy something', () => {
    const { store } = stubStore();
    render(<EndgamePanel store={store} visual={printing} />);
    expect(screen.queryByTestId('endgame')).toBeNull();
  });

  it('lists the tree priced in Plates, and dispatches the purchase', () => {
    const { store, dispatched } = stubStore();
    render(<EndgamePanel store={store} visual={endgame} />);
    const nodes = endgame.upgrades.filter((node) => node.tree === 'endgame');
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes.filter((entry) => entry.available)) {
      expect(screen.getByTestId(`endgame-${node.upgradeId}`).textContent).toContain('plates');
    }
    const buyable = nodes.find((node) => node.available && node.affordable);
    if (buyable !== undefined) {
      fireEvent.click(screen.getByTestId(`buy-${buyable.upgradeId}`));
      expect(dispatched).toEqual([{ type: 'BUY_UPGRADE', upgradeId: buyable.upgradeId }]);
    }
  });

  it('says why the last print is not on offer, rather than offering it (spec §7.3)', () => {
    const { store } = stubStore();
    render(<EndgamePanel store={store} visual={endgame} />);
    const button = screen.getByTestId('start-fabricator');
    expect(endgame.fabricator.available).toBe(false);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).not.toBe('Print it');
  });

  it('counts the layers while the Fabricator prints (spec §6 phase 6)', () => {
    const { store } = stubStore();
    render(<EndgamePanel store={store} visual={fabricating} />);
    expect(screen.getByTestId('fabricator-status').textContent).toContain(
      `layer ${fabricating.fabricator.layer}/${fabricating.fabricator.layers}`,
    );
  });

  it('offers a section to pre-print, and dispatches it', () => {
    const { store, dispatched } = stubStore();
    const ready = {
      ...endgame,
      fabricator: { ...endgame.fabricator, sectionAvailable: true, sectionRunning: false },
    };
    render(<EndgamePanel store={store} visual={ready} />);
    fireEvent.click(screen.getByTestId('print-section'));
    expect(dispatched).toEqual([{ type: 'PRINT_SECTION' }]);
  });
});

describe('the ending (spec §6 phase 6)', () => {
  it('is not shown before the last print lands', () => {
    const { store } = stubStore();
    render(<EndingScreen store={store} visual={endgame} />);
    expect(screen.queryByTestId('ending-screen')).toBeNull();
  });

  it('takes the screen once the credits start', () => {
    const { store } = stubStore();
    render(<EndingScreen store={store} visual={ending} />);
    expect(screen.getByTestId('ending-screen')).toBeTruthy();
    expect(screen.getByTestId('ending').getAttribute('data-stage')).toBe('credits');
    // Still rolling: no offer to start again until the credits are done.
    expect(screen.queryByTestId('new-game-plus')).toBeNull();
  });

  it('offers New Game Plus with the modifiers content declares', () => {
    const { store, dispatched } = stubStore();
    const done = {
      ...ending,
      ending: { ...ending.ending, stage: 'complete' as const, newGamePlusAvailable: true },
    };
    render(<EndingScreen store={store} visual={done} />);
    const modifier = done.ending.modifiers[0];
    if (modifier === undefined) {
      throw new Error('content must offer a modifier');
    }
    fireEvent.click(screen.getByTestId(`ngplus-${modifier.modifierId}`));
    fireEvent.click(screen.getByTestId('start-new-game-plus'));
    expect(dispatched).toEqual([{ type: 'NEW_GAME_PLUS', modifierIds: [modifier.modifierId] }]);
  });
});

describe('the HUD lets the numbers go (spec §6 phase 6)', () => {
  it('reads ∞ once the last print has landed, and reads the ledger before', () => {
    render(<Hud visual={ending} content={content} />);
    expect(ending.ending.infinite).toBe(true);
    expect(screen.getByTestId('money').textContent).toBe('∞');
    expect(screen.getByTestId('parts').textContent).toBe('∞');
    cleanup();
    render(<Hud visual={endgame} content={content} />);
    expect(screen.getByTestId('money').textContent).not.toBe('∞');
  });
});

describe('the HUD shows the economy eating itself (spec §6 phase 5)', () => {
  it('prints the inflation index once it is running, and not before', () => {
    render(<Hud visual={endgame} content={content} />);
    expect(endgame.inflation.active).toBe(true);
    expect(screen.getByTestId('inflation').textContent).toBe(
      `×${endgame.inflation.multiplier.toFixed(2)}`,
    );
    cleanup();
    render(<Hud visual={printing} content={content} />);
    expect(screen.queryByTestId('inflation')).toBeNull();
  });
});
