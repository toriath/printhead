import { CONTENT_FILE_SCHEMAS, type ContentFileName } from '@printhead/core';
import { z } from 'zod';

/**
 * Schema-driven editor (spec §14): the inspector's forms are *generated from
 * the zod schemas*, so a new content type shows up in the editor with zero
 * editor code. M0 ships the descriptor layer (pure, testable); M3 renders it.
 */
export type FieldDescriptor =
  | {
      readonly kind: 'number';
      readonly path: string;
      readonly int: boolean;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: 'string'; readonly path: string }
  | { readonly kind: 'boolean'; readonly path: string }
  | { readonly kind: 'enum'; readonly path: string; readonly options: readonly string[] }
  | { readonly kind: 'literal'; readonly path: string; readonly value: string }
  | { readonly kind: 'object'; readonly path: string; readonly fields: readonly FieldDescriptor[] }
  | { readonly kind: 'array'; readonly path: string; readonly item: FieldDescriptor }
  | { readonly kind: 'union'; readonly path: string; readonly variants: readonly FieldDescriptor[] }
  | { readonly kind: 'unknown'; readonly path: string };

const join = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

export function describeField(schema: z.ZodTypeAny, path = ''): FieldDescriptor {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return describeField(schema.unwrap() as z.ZodTypeAny, path);
  }
  if (schema instanceof z.ZodDefault) {
    return describeField(schema.removeDefault() as z.ZodTypeAny, path);
  }
  if (schema instanceof z.ZodNumber) {
    const descriptor: {
      kind: 'number';
      path: string;
      int: boolean;
      min?: number;
      max?: number;
    } = { kind: 'number', path, int: schema.isInt };
    const min = schema.minValue;
    const max = schema.maxValue;
    if (min !== null) {
      descriptor.min = min;
    }
    if (max !== null) {
      descriptor.max = max;
    }
    return descriptor;
  }
  if (schema instanceof z.ZodString) {
    return { kind: 'string', path };
  }
  if (schema instanceof z.ZodBoolean) {
    return { kind: 'boolean', path };
  }
  if (schema instanceof z.ZodEnum) {
    return { kind: 'enum', path, options: schema.options as readonly string[] };
  }
  if (schema instanceof z.ZodLiteral) {
    return { kind: 'literal', path, value: String(schema.value) };
  }
  if (schema instanceof z.ZodArray) {
    return { kind: 'array', path, item: describeField(schema.element as z.ZodTypeAny, path) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return {
      kind: 'object',
      path,
      fields: Object.entries(shape).map(([key, value]) => describeField(value, join(path, key))),
    };
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    return { kind: 'union', path, variants: options.map((option) => describeField(option, path)) };
  }
  return { kind: 'unknown', path };
}

/** Every content file, described for the inspector — derived, never hand-written. */
export function describeContent(): Record<ContentFileName, FieldDescriptor> {
  const entries = Object.entries(CONTENT_FILE_SCHEMAS).map(
    ([name, schema]) => [name, describeField(schema as z.ZodTypeAny, name)] as const,
  );
  return Object.fromEntries(entries) as Record<ContentFileName, FieldDescriptor>;
}

export function flattenFields(descriptor: FieldDescriptor): readonly FieldDescriptor[] {
  switch (descriptor.kind) {
    case 'object':
      return [descriptor, ...descriptor.fields.flatMap(flattenFields)];
    case 'array':
      return [descriptor, ...flattenFields(descriptor.item)];
    case 'union':
      return [descriptor, ...descriptor.variants.flatMap(flattenFields)];
    default:
      return [descriptor];
  }
}
