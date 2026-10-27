import type { Content } from '@printhead/core';

/**
 * What an upgrade or automation actually does, in one short line, read off its
 * content definition. A price with no effect next to it is a guess; the
 * effects are data, so the description is too.
 */

const pct = (value: number): string => `${Math.round(Math.abs(value) * 100)}%`;

/** The store's content, or nothing for a test double that has none. */
export function contentOf(store: { getContent?: () => Content }): Content | undefined {
  return typeof store.getContent === 'function' ? store.getContent() : undefined;
}

export function describeUpgrade(content: Content | undefined, upgradeId: string): string {
  const def = content?.upgrades.find((candidate) => candidate.id === upgradeId);
  if (def === undefined) {
    return '';
  }
  const parts = def.effects.map((effect) => {
    switch (effect.type) {
      case 'failureChargeMultiplier':
        return `${pct(1 - effect.value)} fewer failures`;
      case 'printSpeedMultiplier':
        return effect.value >= 1
          ? `prints ${pct(effect.value - 1)} faster`
          : `prints ${pct(1 - effect.value)} slower`;
      case 'partsYieldMultiplier':
        return `${pct(effect.value - 1)} more parts`;
      case 'machineTier':
        return `machine tier ${effect.value}`;
      case 'recyclerYieldFraction':
        return `recycle scrap at ${pct(effect.value)}`;
      case 'marketFeeMultiplier':
        return `market fees ${pct(1 - effect.value)} lower`;
      case 'designSlots':
        return `+${effect.value} design desk`;
      case 'productValueMultiplier':
        return `products worth ${pct(effect.value - 1)} more`;
      case 'printerFactoryRate':
        return `prints ${effect.value} printers a minute`;
      default:
        return '';
    }
  });
  const unlocks = (content?.materials ?? [])
    .filter((material) => material.requiresUpgradeId === upgradeId)
    .map((material) => `unlocks ${material.name}`);
  const text = [...unlocks, ...parts.filter((part) => part.length > 0)].join(', ');
  return text.length === 0 ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

const AUTOMATION_TEXT: Readonly<Record<string, string>> = {
  'run-shop': 'Runs the shop front by the stock on the shelf.',
  'answer-proposals': 'Takes on clients as they knock, two orders at a time.',
  'sell-parts': 'Sells parts above a threshold for you',
  'buy-filament': 'Tops up the loaded filament for you',
  'trade-filament': 'Buys filament cheap and sells it dear',
  'auto-changeover': 'Bays work through a rota on their own',
  'recycle-scrap': 'Feeds scrap back into filament for you',
};

export function describeAutomation(content: Content | undefined, automationId: string): string {
  const def = content?.automation.find((candidate) => candidate.id === automationId);
  return def === undefined ? '' : (AUTOMATION_TEXT[def.behavior] ?? '');
}
