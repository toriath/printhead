import type { Content, GameState, VisualState } from '@printhead/core';
import { useRef } from 'react';
import type { ControlModel } from './controls-model.js';

/**
 * Progressive disclosure. An idle game is a story told by its interface: each
 * piece of UI arrives the first time its idea matters, never before, so the
 * player meets one concept at a time and every new panel is a small event.
 *
 * The rules read what the player has *done* (stats) and what they *can do*
 * (the control model), and latch: once something has been shown it stays,
 * even if the condition that summoned it lapses (a printer that was
 * affordable a moment ago is still a thing the player knows about).
 *
 * A hidden element stays in the document with the `hidden` attribute, so
 * tools and tests can still find it; the stylesheet pops it in when it shows.
 */
export interface Reveal {
  readonly money: boolean;
  readonly parts: boolean;
  readonly sell: boolean;
  readonly filament: boolean;
  readonly build: boolean;
  readonly machine: boolean;
  readonly automation: boolean;
  readonly orders: boolean;
  readonly log: boolean;
}

type RevealKey = keyof Reveal;

/** Low stock: the loaded spool holds less than this share of one restock. */
const LOW_STOCK_SHARE = 0.25;

function conditions(
  state: GameState,
  visual: VisualState,
  content: Content,
  model: ControlModel,
): Reveal {
  const { stats } = state;
  const phase = content.pacing.phases.findIndex((candidate) => candidate.id === state.phaseId);
  const pastIntro = phase > 0;
  // Past the Shop, or back after a melt-down, the player has met all of this.
  const shopIndex = content.pacing.phases.findIndex((candidate) => candidate.id === 'shop');
  const veteran = phase > Math.max(shopIndex, 1) || stats.prestigeCount > 0;
  const restock = model.buyFilament;
  const stock = restock === null ? 0 : (visual.ledger.filamentGrams[restock.materialId] ?? 0);
  const lowStock = restock !== null && stock < restock.grams * LOW_STOCK_SHARE;
  const printers = visual.slots.reduce((sum, slot) => sum + slot.printerCount, 0);
  if (veteran) {
    return {
      money: true,
      parts: true,
      sell: true,
      filament: true,
      build: true,
      machine: true,
      automation: true,
      orders: true,
      log: true,
    };
  }
  return {
    money: stats.moneyEarned > 0 || visual.ledger.money > 0,
    parts: stats.partsProduced > 0,
    sell: stats.partsProduced > 0 || stats.productsProduced > 0,
    filament: stats.filamentPurchasedGrams > 0 || (stats.moneyEarned > 0 && lowStock),
    build: printers > 1 || model.buyPrinter?.enabled === true,
    // The machine tree shows as soon as there is something on it to want: its
    // buttons fill toward their price, which is how a player learns to save
    // Parts for it instead of selling every one.
    machine: pastIntro && visual.upgrades.some((row) => row.level > 0 || row.available),
    automation: visual.automation.some((row) => row.installed || (row.available && row.affordable)),
    orders: visual.commissions.offers.length > 0 || visual.commissions.completed > 0,
    log: stats.printsCompleted > 0,
  };
}

export function useReveal(
  state: GameState,
  visual: VisualState,
  content: Content,
  model: ControlModel,
): Reveal {
  const seen = useRef<Set<RevealKey>>(new Set());
  const now = conditions(state, visual, content, model);
  for (const key of Object.keys(now) as RevealKey[]) {
    if (now[key]) {
      seen.current.add(key);
    }
  }
  const has = (key: RevealKey): boolean => seen.current.has(key);
  return {
    money: has('money'),
    parts: has('parts'),
    sell: has('sell'),
    filament: has('filament'),
    build: has('build'),
    machine: has('machine'),
    automation: has('automation'),
    orders: has('orders'),
    log: has('log'),
  };
}
