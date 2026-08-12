import { CONTENT_FILE_NAMES } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeContent, describeField, flattenFields } from './schema-form.js';

describe('describeField', () => {
  it('describes numbers with their bounds', () => {
    expect(describeField(z.number().int().min(0).max(10), 'n')).toEqual({
      kind: 'number',
      path: 'n',
      int: true,
      min: 0,
      max: 10,
    });
  });

  it('unwraps optionals and defaults', () => {
    expect(describeField(z.string().optional(), 's')).toEqual({ kind: 'string', path: 's' });
    expect(describeField(z.number().default(1), 'd').kind).toBe('number');
  });

  it('lists enum options for pickers', () => {
    expect(describeField(z.enum(['a', 'b']), 'e')).toEqual({
      kind: 'enum',
      path: 'e',
      options: ['a', 'b'],
    });
  });

  it('walks nested objects and arrays', () => {
    const descriptor = describeField(z.array(z.object({ id: z.string() })), 'list');
    expect(descriptor.kind).toBe('array');
    expect(flattenFields(descriptor).map((field) => field.path)).toEqual([
      'list',
      'list',
      'list.id',
    ]);
  });

  it('describes discriminated unions variant by variant', () => {
    const descriptor = describeField(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('a'), value: z.number() }),
        z.object({ type: z.literal('b'), step: z.number() }),
      ]),
      'curve',
    );
    expect(descriptor.kind).toBe('union');
    expect(flattenFields(descriptor).some((field) => field.path === 'curve.step')).toBe(true);
  });
});

describe('describeContent', () => {
  const described = describeContent();

  it('covers every content file with no per-type editor code', () => {
    expect(Object.keys(described).sort()).toEqual([...CONTENT_FILE_NAMES].sort());
  });

  it('exposes editable leaves for material balance values', () => {
    const paths = flattenFields(described.materials).map((field) => field.path);
    expect(paths).toContain('materials.costPerGram');
    expect(paths).toContain('materials.supply');
  });

  it('never falls back to an unknown widget for shipped content', () => {
    const unknowns = Object.values(described)
      .flatMap(flattenFields)
      .filter((field) => field.kind === 'unknown');
    expect(unknowns).toEqual([]);
  });
});
