/**
 * Generic scalar helpers.
 *
 * These live outside `systems/` on purpose. `systems/` may contain no numeric
 * literal other than 0 and 1 (spec §11, CI-enforced) because any other number
 * there would be a balance value that escaped `content/*.json`. The constants
 * below are not balance values — they are arithmetic (a full turn is 2π, a
 * unit interval maps onto a signed one by doubling) — so they belong in a
 * shared, separately tested module rather than being smuggled into a system.
 */

/** One full turn in radians. */
export const TAU = Math.PI * 2;

/** Map `[0, 1)` onto `[-1, 1)` — the sign a symmetric noise term needs. */
export function signedUnit(unit: number): number {
  return unit * 2 - 1;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp bounds are inverted: ${min} > ${max}`);
  }
  return Math.min(Math.max(value, min), max);
}
