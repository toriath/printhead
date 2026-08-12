import assembled from './__fixtures__/assembled.json' with { type: 'json' };
import assembling from './__fixtures__/assembling.json' with { type: 'json' };
import economy from './__fixtures__/economy.json' with { type: 'json' };
import fresh from './__fixtures__/fresh.json' with { type: 'json' };
import goliath from './__fixtures__/goliath.json' with { type: 'json' };
import printing from './__fixtures__/printing.json' with { type: 'json' };
import rack from './__fixtures__/rack.json' with { type: 'json' };
import showcase from './__fixtures__/showcase.json' with { type: 'json' };
import type { VisualState } from './schema.js';
import { validateVisualState } from './schema.js';

/**
 * The frozen `VisualState` corpus, shipped from `core` on purpose.
 *
 * Spec §13 requires that *every* `VisualState` fixture renders, and the only
 * way to make that a real guarantee is for the renderer's test to consume the
 * same documents the projection's freeze test does. Exporting them also gives
 * the editor (§14) and any future renderer a ready set of known-good inputs.
 *
 * They are parsed through the strict schema on **first access**, and the result
 * is memoised, so a fixture that has drifted from the contract fails the moment
 * anything reads the corpus — while still leaving the module importable by the
 * generator that has to rewrite the corpus for a new version.
 */
export interface VisualStateFixture {
  readonly name: string;
  /** Why this snapshot exists — printed by the renderer's fixture test. */
  readonly describes: string;
  readonly visual: VisualState;
}

const RAW_FIXTURES: readonly { name: string; describes: string; raw: unknown }[] = [
  { name: 'fresh', describes: 'a brand-new save: bare bench, nothing attached', raw: fresh },
  {
    name: 'assembling',
    describes: 'mid-intro, three pieces attached and the next one cooling down',
    raw: assembling,
  },
  {
    name: 'assembled',
    describes: 'printer #1 built but no config loaded — a staffed, empty bay',
    raw: assembled,
  },
  { name: 'printing', describes: 'the bench loop: one slot mid-batch', raw: printing },
  {
    name: 'economy',
    describes: 'the M3 workshop: a machine node installed, an automation running, scrap in the bin',
    raw: economy,
  },
  {
    name: 'rack',
    describes: 'the M4 rack: two bays, the fleet split between them, a print rota on the second',
    raw: rack,
  },
  {
    name: 'goliath',
    describes: 'the Farm/Goliath fork taken the other way: one giant printer, no rack',
    raw: goliath,
  },
  {
    name: 'showcase',
    describes:
      'four bays, three machine tiers, count badges, a purge in progress and one empty outline',
    raw: showcase,
  },
];

export class VisualFixtureError extends Error {
  constructor(name: string, detail: string) {
    super(`VisualState fixture "${name}" no longer matches the frozen schema: ${detail}`);
    this.name = 'VisualFixtureError';
  }
}

let memoised: readonly VisualStateFixture[] | null = null;

export function visualStateFixtures(): readonly VisualStateFixture[] {
  if (memoised === null) {
    memoised = RAW_FIXTURES.map((entry) => {
      const validation = validateVisualState(entry.raw);
      if (!validation.ok) {
        const detail = validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        throw new VisualFixtureError(entry.name, detail);
      }
      return { name: entry.name, describes: entry.describes, visual: validation.visual };
    });
  }
  return memoised;
}

export function visualFixture(name: string): VisualState {
  const found = visualStateFixtures().find((fixture) => fixture.name === name);
  if (found === undefined) {
    throw new RangeError(`unknown VisualState fixture: ${name}`);
  }
  return found.visual;
}
