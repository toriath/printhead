/**
 * Fixed-timestep engine constants (spec §15). These are *engine* constants, not
 * gameplay numbers: they describe the simulation's resolution, not its balance.
 * Everything a designer would want to tune lives in `content/`.
 */

/** Simulation timestep. One TICK action always advances sim time by this much. */
export const TICK_MS = 100;

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
export const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;

/** Safety valve: never run more than this many ticks in one `advance` call. */
export const MAX_TICKS_PER_ADVANCE = 10_000;

/**
 * Safety valve for the auto-restarting print loop: however short a run becomes,
 * one tick may only close this many of them. Prevents a degenerate content
 * value (a zero-length print) from spinning the reducer forever.
 */
export const MAX_RUN_COMPLETIONS_PER_TICK = 64;

/**
 * Iterations the market's "how much can I afford?" bisection runs. A numerical
 * method's precision, not a balance value: 40 halvings resolve a gram order to
 * far below the smallest amount anything in content trades in.
 */
export const TRADE_SEARCH_ITERATIONS = 40;
