import { describe, expect, it } from 'vitest';
import { ContentValidationError, indexById, loadContent, validateContent } from './load.js';
import { RAW_CONTENT } from './raw.js';
import { checkContentRefs, collectContentIds, referenceKindOf } from './refs.js';
import { CONTENT_FILE_NAMES, type RawContent } from './schema.js';
import { createMutableContentSource, createStaticContentSource } from './source.js';

// `core` compiles without DOM/node libs, so no `structuredClone` here.
const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clone = (raw: RawContent): RawContent => deepClone(raw);

describe('bundled content', () => {
  it('validates against the zod schemas', () => {
    const validation = validateContent(RAW_CONTENT);
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('has no dangling cross-references', () => {
    expect(checkContentRefs(loadContent(RAW_CONTENT))).toEqual([]);
  });

  it('covers every content file named in the spec', () => {
    expect([...CONTENT_FILE_NAMES].sort()).toEqual(
      [
        'automation',
        'commissions',
        'curves',
        'designs',
        'failure',
        'market',
        'materials',
        'objects',
        'pacing',
        'prestige',
        'printers',
        // Not in the spec §11 list, but the same rule applies: the starting
        // kit, the intro assembly, the config-slot progression and the
        // Farm/Goliath fork are numbers, so they are data too.
        'slots',
        'forks',
        'start',
        'upgrades',
        // Likewise the endgame (spec §5E, §6 phases 5–6): the tree, the
        // inflation index, the Fabricator, the credits and New Game Plus.
        'endgame',
        // And the shop front: prices, customers and reputation are numbers.
        'shop',
      ].sort(),
    );
  });

  it('ships a PLA + bracket + tier-1 printer starting kit', () => {
    const content = loadContent(RAW_CONTENT);
    expect(indexById(content.materials).get('pla')?.supply).toBe('infinite');
    expect(indexById(content.objects).has('bracket')).toBe(true);
    expect(indexById(content.printers).get('bench-mk1')?.machineTier).toBe(1);
  });

  it('is calibrated to the 8 h baseline of spec §6', () => {
    const { pacing } = loadContent(RAW_CONTENT);
    expect(pacing.baselineHours).toBe(8);
    expect(pacing.targetHours).toBe(8);
    /*
     * Spec §6's table totals 465 design-minutes across the nine *playable*
     * phases (the original seven, plus The Shop and The Agency grown in since,
     * less the grind taken out of the Melt-downs). `ended` is the last — the post-game sandbox the FSM comes to
     * rest in (spec §15: "Intro → … → Ended") — and it is not part of the arc's
     * budget: nothing ends it, so its "duration" is however long the player
     * stays. Its nominal budget is what the harness uses as a run-out.
     */
    const playable = pacing.phases.slice(0, -1);
    const total = playable.reduce((sum, phase) => sum + phase.budgetDesignMinutes, 0);
    expect(total).toBe(465);
    expect(pacing.phases.at(-1)?.id).toBe('ended');
  });
});

describe('validateContent', () => {
  it('reports schema violations per file without throwing', () => {
    const raw = clone(RAW_CONTENT);
    (raw.materials as { costPerGram: number }[])[0]!.costPerGram = -1;
    const validation = validateContent(raw);
    expect(validation.ok).toBe(false);
    expect(validation.issues[0]?.file).toBe('materials');
  });

  it('rejects unknown fields (typo protection)', () => {
    const raw = clone(RAW_CONTENT);
    (raw.objects as Record<string, unknown>[])[0]!.printDesignSecconds = 5;
    expect(validateContent(raw).ok).toBe(false);
  });

  it('detects duplicate ids', () => {
    const raw = clone(RAW_CONTENT);
    const objects = raw.objects as unknown[];
    objects.push(deepClone(objects[0]));
    const validation = validateContent(raw);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.message.includes('duplicate id'))).toBe(true);
  });

  it('detects dangling references', () => {
    const raw = clone(RAW_CONTENT);
    (raw.printers as { costCurveId: string }[])[0]!.costCurveId = 'ghost-curve';
    const validation = validateContent(raw);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.message.includes('known curve id'))).toBe(true);
  });

  it('loadContent throws a ContentValidationError listing the issues', () => {
    const raw = clone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 0;
    expect(() => loadContent(raw)).toThrow(ContentValidationError);
  });
});

describe('reference kinds', () => {
  it('maps key names onto collections', () => {
    expect(referenceKindOf('costCurveId')).toBe('curve');
    expect(referenceKindOf('requiresUpgradeIds')).toBe('upgrade');
    expect(referenceKindOf('unlockPhaseId')).toBe('phase');
    expect(referenceKindOf('id')).toBeNull();
    expect(referenceKindOf('name')).toBeNull();
  });

  it('flags reference-shaped keys that name no collection', () => {
    const content = loadContent(RAW_CONTENT);
    const rogue = deepClone(content) as unknown as { pacing: Record<string, unknown> };
    rogue.pacing.wibbleId = 'anything';
    const issues = checkContentRefs(rogue as never);
    expect(issues[0]?.reason).toBe('unknown-reference-kind');
  });

  it('indexes ids per collection', () => {
    const ids = collectContentIds(loadContent(RAW_CONTENT));
    expect(ids.phase.has('intro')).toBe(true);
    expect(ids.material.has('pla')).toBe(true);
    expect(ids.curve.has('printer-cost-tier1')).toBe(true);
  });
});

describe('content sources (hot-reload seam)', () => {
  it('static sources expose validated content and never notify', () => {
    const source = createStaticContentSource();
    expect(source.get().materials.length).toBeGreaterThan(0);
    const unsubscribe = source.subscribe(() => {
      throw new Error('static source must not notify');
    });
    unsubscribe();
  });

  it('mutable sources swap content and notify subscribers', () => {
    const source = createMutableContentSource();
    const seen: number[] = [];
    const unsubscribe = source.subscribe((content) => seen.push(content.pacing.targetHours));
    const raw = clone(RAW_CONTENT);
    (raw.pacing as { targetHours: number }).targetHours = 4;
    expect(source.replace(raw).ok).toBe(true);
    expect(seen).toEqual([4]);
    expect(source.get().pacing.targetHours).toBe(4);
    unsubscribe();
  });

  it('mutable sources reject invalid content and keep the last good set', () => {
    const source = createMutableContentSource();
    const before = source.get();
    const raw = clone(RAW_CONTENT);
    (raw.materials as { failureChargePerPrint: number }[])[0]!.failureChargePerPrint = 5;
    const result = source.replace(raw);
    expect(result.ok).toBe(false);
    expect(source.get()).toBe(before);
  });
});
