import type { Action } from '@printhead/core';
import { createPolicyBot } from './bots.js';
import type { Bot, BotView } from './harness.js';

/**
 * Human-ish players. The policy bots are perfect at being themselves: they
 * check in every few seconds, never miss a move and always take the same
 * line, which makes them good rulers and poor witnesses — a balance that only
 * suits them suits nobody. A human bot is one of those policies with a person
 * wrapped around it, drawn from a seed:
 *
 * - a **personality**: greedy or careful, how much reserve it keeps, whether
 *   it chases margins or orders, which branch of the fork it likes, how bold
 *   it is with the overclock, what it charges in the shop;
 * - **attention**: some check-ins it simply lets pass, and now and then it
 *   wanders off for a few minutes;
 * - **sloppiness**: of the moves it meant to make, it forgets a few.
 *
 * Everything is drawn from its own seeded generator, so a human with a given
 * seed plays the same game every time and a failure can be replayed.
 */

/** A tiny, deterministic generator (the simulation's own rng is not ours to use). */
function generator(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const between = (draw: () => number, low: number, high: number): number =>
  low + (high - low) * draw();

/** Seconds between a human's glances at the game. */
const HUMAN_CHECK_IN_SECONDS = 8;
/** Chance per glance of wandering off, and how many glances an absence lasts. */
const WANDER_CHANCE = 0.012;
const WANDER_MIN = 6;
const WANDER_MAX = 40;
const SHOP_PRICES = ['bargain', 'fair', 'premium', null] as const;

export interface HumanTraits {
  readonly attention: number;
  readonly sloppiness: number;
}

export function createHumanBot(seed: number): Bot & { readonly traits: HumanTraits } {
  const draw = generator(seed);
  const greedy = draw() < 0.5;
  const policy = createPolicyBot({
    id: `human-${seed}`,
    checkInDesignSeconds: HUMAN_CHECK_IN_SECONDS,
    capacityFirst: greedy,
    reserveBatches: Math.round(between(draw, 0, 6)),
    chaseMargin: draw() < 0.6,
    preferFork: draw() < 0.5 ? 'throughput' : 'flexibility',
    useQueues: false,
    newGamePlusModifierIds: null,
    overclockBelowRisk: between(draw, 0.2, 1),
    chaseCommissions: draw() < 0.8,
    shopPrice: SHOP_PRICES[Math.floor(draw() * SHOP_PRICES.length)] ?? null,
  });
  const traits: HumanTraits = {
    attention: between(draw, 0.55, 0.95),
    sloppiness: between(draw, 0.05, 0.25),
  };
  let away = 0;
  return {
    id: policy.id,
    traits,
    checkInDesignSeconds: HUMAN_CHECK_IN_SECONDS,
    decide(view: BotView): readonly Action[] {
      if (away > 0) {
        away -= 1;
        return [];
      }
      if (draw() < WANDER_CHANCE) {
        away = Math.round(between(draw, WANDER_MIN, WANDER_MAX));
        return [];
      }
      if (draw() > traits.attention) {
        return [];
      }
      return policy.decide(view).filter(() => draw() >= traits.sloppiness);
    },
  };
}

/** The crowd the report and the gate play: a handful of different people. */
export const HUMAN_SEEDS: readonly number[] = [11, 23, 37, 41, 59, 73];

/** People are slower than rulers: let a human run long before calling it stuck. */
export const HUMAN_LIMIT_DESIGN_MINUTES = 900;
