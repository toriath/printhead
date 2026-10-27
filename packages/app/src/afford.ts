import type { VisualState } from '@printhead/core';
import type { CSSProperties } from 'react';

/**
 * Price buttons that fill up. The idle genre's oldest trick: a button you
 * cannot press yet still shows how close you are, so waiting has a shape and
 * the moment it completes is felt before it is read. `--afford` (0..1) is the
 * fraction of the price the ledger already holds; the stylesheet does the rest.
 */
export function price(
  visual: VisualState,
  cost: number,
  resource: string,
): { className: string; style: CSSProperties } {
  const held = (visual.ledger as unknown as Record<string, number | undefined>)[resource] ?? 0;
  const fraction = cost <= 0 ? 1 : Math.min(held / cost, 1);
  return {
    className: fraction >= 1 ? 'price is-ready' : 'price',
    style: { '--afford': fraction } as CSSProperties,
  };
}
