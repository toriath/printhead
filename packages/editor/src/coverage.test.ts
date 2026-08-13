import { CONTENT_FILE_NAMES, RAW_CONTENT } from '@printhead/core';
import { describe, expect, it } from 'vitest';
import { type PathSegment, getAtPath, inspectContent, pathId } from './inspector.js';

/**
 * Spec §14, M5: *verify* that every content type appears in the editor from its
 * schema alone. "Should be automatic" is a claim, and this is the test that
 * makes it one.
 *
 * The check does not trust the descriptors. It walks the **shipped JSON**,
 * collects every scalar leaf it actually contains, and demands the inspector
 * offer a widget for each. A new content file, a new nested array, a field
 * added to an existing def — any of them that the generator cannot reach shows
 * up here as a named missing path rather than as a form that quietly lost a row.
 */
const model = inspectContent(RAW_CONTENT);

/** Every scalar leaf in a document, with its concrete path. */
function scalarLeaves(node: unknown, path: readonly PathSegment[] = []): readonly string[] {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => scalarLeaves(entry, [...path, index]));
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) => scalarLeaves(value, [...path, key]));
  }
  if (typeof node === 'number' || typeof node === 'string' || typeof node === 'boolean') {
    return [pathId(path)];
  }
  return [];
}

describe('the inspector covers every shipped content file (spec §14)', () => {
  it('offers a form for each file, with no editor code per type', () => {
    expect([...model.keys()]).toEqual([...CONTENT_FILE_NAMES]);
    for (const file of CONTENT_FILE_NAMES) {
      expect(model.get(file)?.length ?? 0, file).toBeGreaterThan(0);
    }
  });

  for (const file of CONTENT_FILE_NAMES) {
    it(`reaches every editable leaf of ${file}.json`, () => {
      const offered = new Set(
        (model.get(file) ?? []).flatMap((group) => group.fields.map((field) => field.id)),
      );
      const missing = scalarLeaves(RAW_CONTENT[file]).filter((leaf) => !offered.has(leaf));
      expect(missing, `${file}.json has leaves the editor cannot reach`).toEqual([]);
    });
  }

  it('reads each offered value straight out of the document it describes', () => {
    for (const file of CONTENT_FILE_NAMES) {
      for (const group of model.get(file) ?? []) {
        for (const field of group.fields) {
          expect(getAtPath(RAW_CONTENT[file], field.path), `${file}:${field.id}`).toBe(field.value);
        }
      }
    }
  });
});
