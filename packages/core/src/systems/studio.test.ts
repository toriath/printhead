import { describe, expect, it } from 'vitest';
import type { Content, DesignDef } from '../content/schema.js';
import { createCurveRegistry } from '../curves/evaluate.js';
import { MS_PER_MINUTE } from '../engine/constants.js';
import { TEST_CONTENT } from '../state/__fixtures__/sim.js';
import { type DesignLedger, type GameState, createInitialState } from '../state/game-state.js';
import {
  countDesignLevels,
  countDesigns,
  creditDesignPrints,
  designAvailability,
  designSlotCount,
  designState,
  freeDesignSlots,
  hasCapstoneDesign,
  hasDesign,
  nextDesignCost,
  productValueOf,
  startDesignDraft,
  tickStudio,
} from './designs.js';
import { computeModifiers } from './upgrades.js';

/**
 * The Design Studio (spec §5D) as an interpreter of `designs.json`.
 *
 * Where the point is the *rule* the tests use fixture defs, so re-balancing the
 * shipped catalogue cannot turn them red; where the point is that the shipped
 * content is wired up correctly, they use the real thing.
 */
const content = TEST_CONTENT;
const curves = createCurveRegistry(content.curves);
const base = createInitialState(content, { seed: 1 });
const capstoneId = content.prestige.requiredDesignId;

const fixtureDesign = (over: Partial<DesignDef> = {}): DesignDef =>
  ({
    id: 'test-design',
    name: 'Test design',
    requiredMaterialId: 'resin',
    designDesignMinutes: 4,
    printDesignSeconds: 60,
    filamentGrams: 10,
    baseProductValue: 100,
    levelValueCurveId: 'design-level-value',
    printsPerLevel: 3,
    maxLevel: 5,
    costCurveId: 'design-cost',
    costResource: 'money',
    unlockPhaseId: 'studio',
    ...over,
  }) as DesignDef;

/** A workshop where drafting is legal: studio phase, resin open, money banked. */
const studio = (over: Partial<GameState> = {}): GameState => ({
  ...base,
  phaseId: 'studio',
  upgrades: { 'heated-bed': 1, enclosure: 1, 'sla-unit': 1 },
  resources: { ...base.resources, money: 1_000_000 },
  ...over,
});

const modifiersFor = (state: GameState, set: Content = content) => computeModifiers(state, set);

describe('the design ledger', () => {
  it('reports what the studio owns and how far it has been pushed', () => {
    const owned: DesignLedger = {
      alpha: { level: 3, printsOnLevel: 1 },
      beta: { level: 2, printsOnLevel: 0 },
    };
    const state = studio({ designs: owned });
    expect(countDesigns(state)).toBe(2);
    expect(countDesignLevels(state)).toBe(5);
    expect(hasDesign(state, 'alpha')).toBe(true);
    expect(hasDesign(state, 'gamma')).toBe(false);
    expect(designState(state, 'beta')).toEqual({ level: 2, printsOnLevel: 0 });
    expect(designState(state, 'gamma')).toBeNull();
  });

  it('starts empty, so a fresh workshop has drafted nothing', () => {
    expect(countDesigns(base)).toBe(0);
    expect(countDesignLevels(base)).toBe(0);
    expect(hasCapstoneDesign(base, content)).toBe(false);
  });

  it('knows the capstone by what prestige.json names, not by its id', () => {
    expect(
      hasCapstoneDesign(
        studio({ designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } } }),
        content,
      ),
    ).toBe(true);
    const repointed: Content = {
      ...content,
      prestige: { ...content.prestige, requiredDesignId: 'phone-stand' },
    };
    const state = studio({ designs: { 'phone-stand': { level: 1, printsOnLevel: 0 } } });
    expect(hasCapstoneDesign(state, repointed)).toBe(true);
    expect(hasCapstoneDesign(state, content)).toBe(false);
  });
});

describe('design slots (spec §5D)', () => {
  it('is the content baseline plus whatever the design tree adds', () => {
    const bare = modifiersFor(base);
    expect(designSlotCount(content, bare)).toBe(content.start.designSlots);
    const desked = modifiersFor(studio({ upgrades: { 'sla-unit': 1, 'design-desk': 2 } }));
    expect(designSlotCount(content, desked)).toBe(content.start.designSlots + 2);
  });

  it('counts the free ones, and never goes below zero', () => {
    const one = studio({ designs: { alpha: { level: 1, printsOnLevel: 0 } } });
    expect(freeDesignSlots(one, content, modifiersFor(one))).toBe(content.start.designSlots - 1);
    const overfull = studio({
      designs: {
        alpha: { level: 1, printsOnLevel: 0 },
        beta: { level: 1, printsOnLevel: 0 },
        gamma: { level: 1, printsOnLevel: 0 },
      },
    });
    expect(freeDesignSlots(overfull, content, modifiersFor(overfull))).toBe(0);
  });
});

describe('what a Product is worth', () => {
  const bare = modifiersFor(base);

  it('is the authored base value at level 1 — the curve starts at zero', () => {
    expect(productValueOf(fixtureDesign(), curves, 1, bare)).toBe(100);
  });

  it('rises with the level, never falls', () => {
    let previous = 0;
    for (let level = 1; level <= 10; level += 1) {
      const value = productValueOf(fixtureDesign(), curves, level, bare);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('treats level 0 as level 1, so an unowned Design still quotes a price', () => {
    expect(productValueOf(fixtureDesign(), curves, 0, bare)).toBe(
      productValueOf(fixtureDesign(), curves, 1, bare),
    );
  });

  it('is multiplied by the design tree, not by anything in code', () => {
    const polished = modifiersFor(
      studio({ upgrades: { 'sla-unit': 1, 'design-desk': 1, 'polish-station': 2 } }),
    );
    expect(productValueOf(fixtureDesign(), curves, 1, polished)).toBeGreaterThan(
      productValueOf(fixtureDesign(), curves, 1, bare),
    );
  });
});

describe('what a draft costs', () => {
  it('is priced by how many Designs the studio has already produced', () => {
    const first = nextDesignCost(base, content, curves, capstoneId);
    const second = nextDesignCost(
      studio({ designs: { 'phone-stand': { level: 1, printsOnLevel: 0 } } }),
      content,
      curves,
      capstoneId,
    );
    expect(first).not.toBeNull();
    expect(second?.amount ?? 0).toBeGreaterThan(first?.amount ?? 0);
  });

  it('is the same price whichever Design is drafted next', () => {
    const a = nextDesignCost(base, content, curves, 'phone-stand');
    const b = nextDesignCost(base, content, curves, capstoneId);
    expect(a?.amount).toBe(b?.amount);
  });

  it('rounds a countable resource up, and leaves Money alone', () => {
    // A fractional price, so "rounded up" and "left alone" are different
    // numbers: against an integral curve this would pass either way.
    const fractional = 'fractional-design-cost';
    const priced: Content = {
      ...content,
      curves: [
        ...content.curves,
        { id: fractional, name: 'Fractional', type: 'constant' as const, value: 100.5 },
      ],
      designs: content.designs.map((def) => ({ ...def, costCurveId: fractional })),
    };
    const pricedCurves = createCurveRegistry(priced.curves);
    expect(nextDesignCost(base, priced, pricedCurves, capstoneId)).toEqual({
      resource: 'money',
      amount: 100.5,
    });

    const counted: Content = {
      ...priced,
      designs: priced.designs.map((def) => ({ ...def, costResource: 'parts' as const })),
    };
    expect(nextDesignCost(base, counted, pricedCurves, capstoneId)).toEqual({
      resource: 'parts',
      amount: 101,
    });
  });

  it('has no price for a Design that is not in content', () => {
    expect(nextDesignCost(base, content, curves, 'no-such-design')).toBeNull();
  });
});

describe('whether the studio will take the commission', () => {
  const ask = (state: GameState, designId: string, set: Content = content) =>
    designAvailability(state, set, modifiersFor(state, set), designId);

  it('takes it when the phase, the material and a free slot all agree', () => {
    expect(ask(studio(), capstoneId)).toBeNull();
  });

  it('refuses a Design content has never heard of', () => {
    expect(ask(studio(), 'no-such-design')).toBe('unknown-target');
  });

  it('refuses before the studio phase opens', () => {
    expect(ask(studio({ phaseId: 'bench' }), capstoneId)).toBe('locked');
  });

  it('refuses one it has already drafted — a Design is levelled, not re-bought', () => {
    expect(
      ask(studio({ designs: { [capstoneId]: { level: 1, printsOnLevel: 0 } } }), capstoneId),
    ).toBe('already-owned');
  });

  it('refuses while the bench is busy: the studio is a place, not a queue', () => {
    expect(
      ask(studio({ studio: { designId: 'phone-stand', remainingMs: 1000 } }), capstoneId),
    ).toBe('slot-busy');
  });

  it('refuses until the machine tree opens the material the Design names (spec §3)', () => {
    expect(ask(studio({ upgrades: {} }), capstoneId)).toBe('missing-prerequisite');
  });

  it('refuses when every design slot is taken', () => {
    const full = studio({
      designs: Object.fromEntries(
        content.designs
          .filter((def) => def.id !== capstoneId)
          .map((def) => [def.id, { level: 1, printsOnLevel: 0 }]),
      ),
    });
    expect(ask(full, capstoneId)).toBe('slot-full');
    // ...and a desk fixes it, because the slot count is an upgrade effect.
    expect(
      ask({ ...full, upgrades: { ...full.upgrades, 'design-desk': 2 } }, capstoneId),
    ).toBeNull();
  });
});

describe('putting a commission on the bench', () => {
  it('pays for it and starts the clock in design-milliseconds', () => {
    const draft = startDesignDraft(studio(), content, curves, capstoneId);
    expect(draft).not.toBeNull();
    const def = content.designs.find((candidate) => candidate.id === capstoneId);
    expect(draft?.state.studio).toEqual({
      designId: capstoneId,
      remainingMs: (def?.designDesignMinutes ?? 0) * MS_PER_MINUTE,
    });
    expect(draft?.state.resources.money).toBe(1_000_000 - (draft?.cost.amount ?? 0));
  });

  it('will not start one the workshop cannot pay for', () => {
    expect(
      startDesignDraft(
        studio({ resources: { ...base.resources, money: 1 } }),
        content,
        curves,
        capstoneId,
      ),
    ).toBeNull();
  });

  it('will not start one content does not describe', () => {
    expect(startDesignDraft(studio(), content, curves, 'no-such-design')).toBeNull();
  });
});

describe('the bench clock', () => {
  it('burns design time and hands nothing back until it is finished', () => {
    const state = studio({ studio: { designId: capstoneId, remainingMs: 500 } });
    const result = tickStudio(state, 100);
    expect('designId' in result).toBe(false);
    expect((result as GameState).studio?.remainingMs).toBe(400);
  });

  it('does nothing at all when the bench is free', () => {
    const state = studio();
    expect(tickStudio(state, 100)).toBe(state);
  });

  it('hands back a level-1 Design and clears the bench when the time is up', () => {
    const state = studio({ studio: { designId: capstoneId, remainingMs: 100 } });
    const result = tickStudio(state, 100);
    expect('designId' in result).toBe(true);
    const finished = result as { designId: string; state: GameState };
    expect(finished.designId).toBe(capstoneId);
    expect(finished.state.studio).toBeNull();
    expect(finished.state.designs[capstoneId]).toEqual({ level: 1, printsOnLevel: 0 });
    // The mirror the phase gates read has to move with the ledger.
    expect(finished.state.resources.designs).toBe(1);
  });

  it('finishes a draft that overshoots its last tick rather than leaving a sliver', () => {
    const state = studio({ studio: { designId: capstoneId, remainingMs: 40 } });
    expect('designId' in tickStudio(state, 100)).toBe(true);
  });
});

describe('levelling a Design by printing it (spec §5D)', () => {
  const def = fixtureDesign();
  const owned = (level: number, printsOnLevel: number): DesignLedger => ({
    [def.id]: { level, printsOnLevel },
  });

  it('counts prints, not batches, so a rack levels faster than one machine', () => {
    const one = creditDesignPrints(owned(1, 0), def, 1);
    const eight = creditDesignPrints(owned(1, 0), def, 8);
    expect(one.designs[def.id]).toEqual({ level: 1, printsOnLevel: 1 });
    expect(eight.designs[def.id]?.level).toBeGreaterThan(one.designs[def.id]?.level ?? 0);
  });

  it('carries the remainder across a level boundary', () => {
    const progress = creditDesignPrints(owned(1, 2), def, 2);
    expect(progress.designs[def.id]).toEqual({ level: 2, printsOnLevel: 1 });
    expect(progress.levelUp).toEqual({ designId: def.id, level: 2 });
  });

  it('can climb several levels in one batch', () => {
    const progress = creditDesignPrints(owned(1, 0), def, 9);
    expect(progress.designs[def.id]).toEqual({ level: 4, printsOnLevel: 0 });
    expect(progress.levelUp).toEqual({ designId: def.id, level: 4 });
  });

  it('reports no level-up when the batch only makes progress', () => {
    expect(creditDesignPrints(owned(1, 0), def, 1).levelUp).toBeNull();
  });

  it('stops at the cap and does not bank progress beyond it', () => {
    const progress = creditDesignPrints(owned(1, 0), def, 1000);
    expect(progress.designs[def.id]).toEqual({ level: def.maxLevel, printsOnLevel: 0 });
    // Already capped: nothing changes, and the ledger is handed back untouched.
    const again = creditDesignPrints(progress.designs, def, 50);
    expect(again.designs).toBe(progress.designs);
    expect(again.levelUp).toBeNull();
  });

  it('ignores a Design the studio does not own, and an empty batch', () => {
    const ledger = owned(1, 0);
    expect(creditDesignPrints({}, def, 5).designs).toEqual({});
    expect(creditDesignPrints(ledger, def, 0).designs).toBe(ledger);
    expect(creditDesignPrints(ledger, def, -3).designs).toBe(ledger);
  });
});
