import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@printhead/core';

/** Display helpers. Nothing here may influence the simulation. */

export function formatAmount(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(value < 10 ? 2 : 1);
}

export function formatMoney(value: number): string {
  return `¤${formatAmount(value)}`;
}

export function formatGrams(value: number): string {
  return `${formatAmount(value)} g`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%`;
}

/** Compact wall-clock duration: `2 h 5 m`, `45 s`. */
export function formatDuration(ms: number): string {
  const clamped = Math.max(ms, 0);
  const hours = Math.floor(clamped / MS_PER_HOUR);
  const minutes = Math.floor((clamped % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((clamped % MS_PER_MINUTE) / MS_PER_SECOND);
  if (hours > 0) {
    return `${hours} h ${minutes} m`;
  }
  if (minutes > 0) {
    return `${minutes} m ${seconds} s`;
  }
  return `${seconds} s`;
}

/** Design-milliseconds left on a cooldown, shown as whole seconds. */
export function formatCountdown(ms: number): string {
  return `${Math.ceil(Math.max(ms, 0) / MS_PER_SECOND)} s`;
}
