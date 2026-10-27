import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@printhead/core';

/** Display helpers. Nothing here may influence the simulation. */

/** Suffixes for big numbers, one per factor of a thousand. */
const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc'];
/** Below this, numbers are written out in full. */
const ABBREVIATE_FROM = 10_000;

export function formatAmount(value: number): string {
  const size = Math.abs(value);
  if (size >= ABBREVIATE_FROM && Number.isFinite(value)) {
    let tier = Math.min(Math.floor(Math.log10(size) / 3), SUFFIXES.length - 1);
    // 999,999 would round to "1000K": that is "1.00M".
    if (Math.round(size / 1000 ** tier) >= 1000 && tier < SUFFIXES.length - 1) {
      tier += 1;
    }
    const scaled = value / 1000 ** tier;
    const digits = Math.abs(scaled) < 10 ? 2 : Math.abs(scaled) < 100 ? 1 : 0;
    return `${scaled.toFixed(digits)}${SUFFIXES[tier] ?? ''}`;
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(size < 10 ? 2 : 1);
}

export function formatMoney(value: number): string {
  return `$${formatAmount(value)}`;
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
