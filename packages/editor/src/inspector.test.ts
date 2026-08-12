import { CONTENT_FILE_NAMES, RAW_CONTENT, loadContent, validateContent } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import {
  editableFields,
  editableGroups,
  getAtPath,
  inspectContent,
  pathId,
  setAtPath,
} from './inspector.js';
import { describeContent } from './schema-form.js';

const described = describeContent();

describe('editableFields', () => {
  it('walks a real document and yields concrete, addressable leaves', () => {
    const fields = editableFields(described.materials, RAW_CONTENT.materials);
    const ids = fields.map((field) => field.id);
    expect(ids).toContain('0.costPerGram');
    expect(ids).toContain('1.valueMultiplier');
    const cost = fields.find((field) => field.id === '0.costPerGram');
    expect(cost?.kind).toBe('number');
    expect(cost?.value).toBe(loadContent(RAW_CONTENT).materials[0]?.costPerGram);
  });

  it('carries the bounds the schema declares, so a widget can enforce them', () => {
    const fields = editableFields(described.materials, RAW_CONTENT.materials);
    const fraction = fields.find((field) => field.id === '0.failureChargePerPrint');
    expect(fraction?.min).toBe(0);
    expect(fraction?.max).toBe(1);
    const tier = fields.find((field) => field.id === '0.qualityTier');
    expect(tier?.int).toBe(true);
  });

  it('offers an enum as a picker with its options', () => {
    const supply = editableFields(described.materials, RAW_CONTENT.materials).find(
      (field) => field.id === '0.supply',
    );
    expect(supply?.kind).toBe('enum');
    expect(supply?.options).toContain('market');
  });

  it('never offers a literal — a discriminator is the shape, not a setting', () => {
    const fields = editableFields(described.curves, RAW_CONTENT.curves);
    expect(fields.some((field) => field.label === 'type')).toBe(false);
    // ...but the variant's own numbers are editable.
    expect(fields.some((field) => field.label === 'growth')).toBe(true);
  });

  it('picks the union variant the document actually is', () => {
    // curves.json mixes exponential, power, linear and constant curves.
    const fields = editableFields(described.curves, RAW_CONTENT.curves);
    const curves = loadContent(RAW_CONTENT).curves;
    const constantIndex = curves.findIndex((curve) => curve.type === 'constant');
    const linearIndex = curves.findIndex((curve) => curve.type === 'linear');
    expect(fields.some((field) => field.id === `${constantIndex}.value`)).toBe(true);
    expect(fields.some((field) => field.id === `${linearIndex}.step`)).toBe(true);
    // A constant curve must not sprout an exponential's fields.
    expect(fields.some((field) => field.id === `${constantIndex}.growth`)).toBe(false);
  });

  it('descends into nested objects and arrays', () => {
    const fields = editableFields(described.pacing, RAW_CONTENT.pacing);
    expect(fields.map((field) => field.id)).toContain('phases.0.budgetDesignMinutes');
    expect(fields.map((field) => field.id)).toContain('targetHours');
  });

  it('yields nothing for a document of the wrong shape rather than throwing', () => {
    expect(editableFields(described.materials, 'not an array')).toEqual([]);
    expect(editableFields(described.pacing, 42)).toEqual([]);
  });
});

describe('editableGroups', () => {
  it('gives an array file one section per def, named by its id', () => {
    const groups = editableGroups(described.materials, RAW_CONTENT.materials);
    expect(groups.map((group) => group.label)).toEqual(
      loadContent(RAW_CONTENT).materials.map((material) => material.id),
    );
  });

  it('gives an object file a single section', () => {
    const groups = editableGroups(described.market, RAW_CONTENT.market);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.fields.some((field) => field.id === 'model.spread')).toBe(true);
  });

  it('falls back to a positional label when a def has no id', () => {
    const groups = editableGroups(described.materials, [{ costPerGram: 1 }]);
    expect(groups[0]?.label).toBe('#1');
  });
});

describe('setAtPath / getAtPath', () => {
  it('replaces a value without touching the original', () => {
    const next = setAtPath(RAW_CONTENT.materials, [0, 'costPerGram'], 9.5);
    expect(getAtPath(next, [0, 'costPerGram'])).toBe(9.5);
    expect(getAtPath(RAW_CONTENT.materials, [0, 'costPerGram'])).not.toBe(9.5);
  });

  it('leaves every sibling identical', () => {
    const before = RAW_CONTENT.materials as unknown[];
    const next = setAtPath(before, [0, 'costPerGram'], 1) as unknown[];
    expect(next[1]).toBe(before[1]);
  });

  it('reaches through nested objects and arrays', () => {
    const next = setAtPath(RAW_CONTENT.pacing, ['phases', 0, 'budgetDesignMinutes'], 11);
    expect(getAtPath(next, ['phases', 0, 'budgetDesignMinutes'])).toBe(11);
  });

  it('is null-safe when reading a path that does not exist', () => {
    expect(getAtPath(RAW_CONTENT.materials, [99, 'nope'])).toBeUndefined();
    expect(getAtPath(undefined, ['a'])).toBeUndefined();
  });

  it('refuses to index the wrong kind of node instead of writing nonsense', () => {
    expect(() => setAtPath({ a: 1 }, [0], 2)).toThrow(TypeError);
    expect(() => setAtPath([1], ['a'], 2)).toThrow(TypeError);
  });

  it('renders a path as a dotted id', () => {
    expect(pathId(['phases', 0, 'budgetDesignMinutes'])).toBe('phases.0.budgetDesignMinutes');
  });
});

describe('inspectContent', () => {
  /**
   * The promise of spec §14: a new content type appears in the editor with zero
   * editor code. `failure.json` was added in M3 and nothing here was touched.
   */
  it('covers every content file the schema map knows, automatically', () => {
    const inspected = inspectContent(RAW_CONTENT);
    expect([...inspected.keys()].sort()).toEqual([...CONTENT_FILE_NAMES].sort());
    for (const [file, groups] of inspected) {
      expect(groups.length, file).toBeGreaterThan(0);
      expect(
        groups.some((group) => group.fields.length > 0),
        file,
      ).toBe(true);
    }
  });

  it('round-trips: editing every leaf back to its own value leaves content valid', () => {
    const inspected = inspectContent(RAW_CONTENT);
    for (const [file, groups] of inspected) {
      let document: unknown = RAW_CONTENT[file];
      for (const group of groups) {
        for (const field of group.fields) {
          document = setAtPath(document, field.path, field.value);
        }
      }
      const validation = validateContent({ ...RAW_CONTENT, [file]: document });
      expect(validation.ok, `${file}: ${JSON.stringify(validation.issues)}`).toBe(true);
    }
  });
});
