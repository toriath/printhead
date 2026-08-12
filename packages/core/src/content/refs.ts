import type { Content } from './schema.js';

/**
 * Cross-reference checker (spec §11: "a broken ref fails CI, not runtime").
 *
 * It is deliberately *generic*: any content key that ends in `Id`/`Ids` is a
 * reference, and the collection it points at is derived from the key name
 * (`costCurveId` → curves, `requiresUpgradeIds` → upgrades). New content types
 * therefore get referential integrity for free, with no checker changes.
 */
export const COLLECTION_SINGULARS = [
  'material',
  'object',
  'printer',
  'upgrade',
  'slot',
  'fork',
  'design',
  'automation',
  'phase',
  'curve',
  'piece',
] as const;

export type CollectionSingular = (typeof COLLECTION_SINGULARS)[number];

export type ContentIdIndex = Readonly<Record<CollectionSingular, ReadonlySet<string>>>;

export type ContentRefReason = 'unknown-reference-kind' | 'dangling-reference';

export interface ContentRefIssue {
  readonly path: string;
  readonly key: string;
  readonly value: string;
  readonly kind: CollectionSingular | null;
  readonly reason: ContentRefReason;
}

export interface ContentDuplicateIssue {
  readonly collection: CollectionSingular;
  readonly id: string;
}

const ID_SUFFIX = 'Id';
const ID_LIST_SUFFIX = 'Ids';

export function collectContentIds(content: Content): ContentIdIndex {
  const ids = (list: readonly { id: string }[]): ReadonlySet<string> =>
    new Set(list.map((entry) => entry.id));
  return {
    material: ids(content.materials),
    object: ids(content.objects),
    printer: ids(content.printers),
    upgrade: ids(content.upgrades),
    slot: ids(content.slots),
    fork: ids(content.forks),
    design: ids(content.designs),
    automation: ids(content.automation),
    phase: ids(content.pacing.phases),
    curve: ids(content.curves),
    piece: ids(content.start.assemblyPieces),
  };
}

export function findDuplicateIds(content: Content): ContentDuplicateIssue[] {
  const collections: Readonly<Record<CollectionSingular, readonly { id: string }[]>> = {
    material: content.materials,
    object: content.objects,
    printer: content.printers,
    upgrade: content.upgrades,
    slot: content.slots,
    fork: content.forks,
    design: content.designs,
    automation: content.automation,
    phase: content.pacing.phases,
    curve: content.curves,
    piece: content.start.assemblyPieces,
  };
  const issues: ContentDuplicateIssue[] = [];
  for (const singular of COLLECTION_SINGULARS) {
    const seen = new Set<string>();
    for (const entry of collections[singular]) {
      if (seen.has(entry.id)) {
        issues.push({ collection: singular, id: entry.id });
      }
      seen.add(entry.id);
    }
  }
  return issues;
}

/** `costCurveId` → `curve`; returns null when the key names no known collection. */
export function referenceKindOf(key: string): CollectionSingular | null {
  const stem = referenceStem(key);
  if (stem === null) {
    return null;
  }
  const lowered = stem.toLowerCase();
  let best: CollectionSingular | null = null;
  for (const singular of COLLECTION_SINGULARS) {
    if (lowered.endsWith(singular) && (best === null || singular.length > best.length)) {
      best = singular;
    }
  }
  return best;
}

function referenceStem(key: string): string | null {
  if (key === 'id') {
    return null;
  }
  if (key.endsWith(ID_LIST_SUFFIX)) {
    return key.slice(0, key.length - ID_LIST_SUFFIX.length);
  }
  if (key.endsWith(ID_SUFFIX)) {
    return key.slice(0, key.length - ID_SUFFIX.length);
  }
  return null;
}

export function isReferenceKey(key: string): boolean {
  return referenceStem(key) !== null;
}

export function checkContentRefs(content: Content): ContentRefIssue[] {
  const index = collectContentIds(content);
  const issues: ContentRefIssue[] = [];

  const visitValue = (value: unknown, path: string, key: string): void => {
    if (typeof value === 'string') {
      const kind = referenceKindOf(key);
      if (kind === null) {
        issues.push({ path, key, value, kind: null, reason: 'unknown-reference-kind' });
        return;
      }
      if (!index[kind].has(value)) {
        issues.push({ path, key, value, kind, reason: 'dangling-reference' });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => {
        visitValue(entry, `${path}[${i}]`, key);
      });
    }
  };

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, i) => {
        walk(entry, `${path}[${i}]`);
      });
      return;
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (isReferenceKey(key)) {
        visitValue(value, childPath, key);
        continue;
      }
      walk(value, childPath);
    }
  };

  walk(content, 'content');
  return issues;
}

export function formatRefIssue(issue: ContentRefIssue): string {
  return issue.reason === 'unknown-reference-kind'
    ? `${issue.path}: key "${issue.key}" looks like a reference but names no known collection`
    : `${issue.path}: "${issue.value}" is not a known ${issue.kind} id`;
}
