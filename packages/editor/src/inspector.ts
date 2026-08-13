import type { ContentFileName, RawContent } from '@printhead/core';
import { CONTENT_FILE_NAMES } from '@printhead/core';
import { type FieldDescriptor, describeContent } from './schema-form.js';

/**
 * The content inspector's model (spec §14).
 *
 * `schema-form.ts` describes what a content file *may* contain; this walks a
 * real document alongside that description and produces the concrete, editable
 * leaves — with concrete paths, so `materials[1].costPerGram` is addressable
 * rather than the schema-shaped `materials.costPerGram`.
 *
 * Nothing here knows what a material or a curve is. A new content type appears
 * in the editor because its zod schema exists, which is the whole promise of
 * §14: "new content types appear in the editor automatically, zero editor code".
 */
export type PathSegment = string | number;

export interface EditableField {
  /** Concrete path into the file's JSON, e.g. `['materials', 1, 'costPerGram']`. */
  readonly path: readonly PathSegment[];
  /** Dotted rendering of the path, used as a React key and a test handle. */
  readonly id: string;
  readonly label: string;
  /**
   * `literal` is a union's own discriminator — `curves[].type`,
   * `automation[].behavior`. It is shown but never edited: changing it would
   * mean rewriting every sibling field to match a different variant's shape,
   * which is a different content def rather than an edit to this one. Hiding
   * it instead was the old behaviour and was worse: the inspector then could
   * not tell you whether a curve was exponential or a power law.
   */
  readonly kind: 'number' | 'string' | 'boolean' | 'enum' | 'literal';
  readonly value: number | string | boolean;
  readonly options?: readonly string[];
  readonly int?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** True for `literal`: the panel renders it as text, not a widget. */
  readonly readOnly?: boolean;
}

/** A group of fields the inspector shows together — one def, one section. */
export interface EditableGroup {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly EditableField[];
}

export const pathId = (path: readonly PathSegment[]): string => path.join('.');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Which variant of a discriminated union a document is. The union descriptor
 * lost the discriminator's *name*, so the match is structural: the variant
 * whose literal fields all agree with the document wins, and failing that the
 * one that explains the most of its keys.
 */
function pickVariant(
  variants: readonly FieldDescriptor[],
  value: unknown,
): FieldDescriptor | undefined {
  if (!isRecord(value)) {
    return variants[0];
  }
  const keys = new Set(Object.keys(value));
  let best: { descriptor: FieldDescriptor; score: number } | undefined;
  for (const variant of variants) {
    if (variant.kind !== 'object') {
      continue;
    }
    let score = 0;
    let contradicted = false;
    for (const field of variant.fields) {
      const key = field.path.split('.').at(-1) ?? '';
      if (field.kind === 'literal') {
        if (value[key] === field.value) {
          // A matching discriminator is decisive.
          score += variant.fields.length;
        } else {
          contradicted = true;
        }
        continue;
      }
      if (keys.has(key)) {
        score += 1;
      }
    }
    if (contradicted) {
      continue;
    }
    if (best === undefined || score > best.score) {
      best = { descriptor: variant, score };
    }
  }
  return best?.descriptor ?? variants[0];
}

function leafOf(
  descriptor: FieldDescriptor,
  path: readonly PathSegment[],
  value: unknown,
): EditableField | null {
  const label = String(path.at(-1) ?? '');
  const base = { path, id: pathId(path), label };
  switch (descriptor.kind) {
    case 'number':
      return typeof value === 'number'
        ? {
            ...base,
            kind: 'number',
            value,
            int: descriptor.int,
            ...(descriptor.min === undefined ? {} : { min: descriptor.min }),
            ...(descriptor.max === undefined ? {} : { max: descriptor.max }),
          }
        : null;
    case 'string':
      return typeof value === 'string' ? { ...base, kind: 'string', value } : null;
    case 'boolean':
      return typeof value === 'boolean' ? { ...base, kind: 'boolean', value } : null;
    case 'enum':
      return typeof value === 'string'
        ? { ...base, kind: 'enum', value, options: descriptor.options }
        : null;
    case 'literal':
      // Reported, so the form says which variant this def is, but read-only.
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? { ...base, kind: 'literal', value, readOnly: true }
        : null;
    default:
      // An `unknown` has no widget, because the schema gave no shape to draw.
      return null;
  }
}

/** Every editable leaf of `value`, in document order. */
export function editableFields(
  descriptor: FieldDescriptor,
  value: unknown,
  path: readonly PathSegment[] = [],
): readonly EditableField[] {
  switch (descriptor.kind) {
    case 'object': {
      if (!isRecord(value)) {
        return [];
      }
      return descriptor.fields.flatMap((field) => {
        const key = field.path.split('.').at(-1) ?? '';
        return editableFields(field, value[key], [...path, key]);
      });
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return [];
      }
      return value.flatMap((entry, index) =>
        editableFields(descriptor.item, entry, [...path, index]),
      );
    }
    case 'union': {
      const variant = pickVariant(descriptor.variants, value);
      return variant === undefined ? [] : editableFields(variant, value, path);
    }
    default: {
      const leaf = leafOf(descriptor, path, value);
      return leaf === null ? [] : [leaf];
    }
  }
}

/**
 * Fields grouped for display: one section per array element (named by its `id`
 * when it has one), or a single section for a plain object file.
 */
export function editableGroups(
  descriptor: FieldDescriptor,
  value: unknown,
): readonly EditableGroup[] {
  if (descriptor.kind === 'array' && Array.isArray(value)) {
    return value.map((entry, index) => ({
      id: String(index),
      label: isRecord(entry) && typeof entry.id === 'string' ? entry.id : `#${index + 1}`,
      fields: editableFields(descriptor.item, entry, [index]),
    }));
  }
  return [{ id: 'root', label: 'settings', fields: editableFields(descriptor, value) }];
}

/** An immutable set: returns a copy of `root` with `path` replaced. */
export function setAtPath(
  root: unknown,
  path: readonly PathSegment[],
  value: number | string | boolean,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) {
    return value;
  }
  if (typeof head === 'number') {
    if (!Array.isArray(root)) {
      throw new TypeError(`cannot index ${typeof root} at [${head}]`);
    }
    return root.map((entry, index) => (index === head ? setAtPath(entry, rest, value) : entry));
  }
  if (!isRecord(root)) {
    throw new TypeError(`cannot set "${head}" on ${typeof root}`);
  }
  return { ...root, [head]: setAtPath(root[head], rest, value) };
}

export function getAtPath(root: unknown, path: readonly PathSegment[]): unknown {
  let node: unknown = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      node = Array.isArray(node) ? node[segment] : undefined;
      continue;
    }
    node = isRecord(node) ? node[segment] : undefined;
  }
  return node;
}

/**
 * The inspector's whole model: every content file, described from its schema
 * and populated from the live document. Adding `designs.json` to
 * `CONTENT_FILE_SCHEMAS` makes it appear here with no editor change at all.
 */
export function inspectContent(raw: RawContent): ReadonlyMap<ContentFileName, EditableGroup[]> {
  const described = describeContent();
  return new Map(
    CONTENT_FILE_NAMES.map((file) => [file, [...editableGroups(described[file], raw[file])]]),
  );
}
