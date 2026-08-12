import { checkContentRefs, findDuplicateIds, formatRefIssue } from './refs.js';
import {
  CONTENT_FILE_NAMES,
  CONTENT_FILE_SCHEMAS,
  type Content,
  type ContentFileName,
  type RawContent,
} from './schema.js';

export interface ContentIssue {
  readonly file: ContentFileName | null;
  readonly path: string;
  readonly message: string;
}

export type ContentValidation =
  | { readonly ok: true; readonly content: Content; readonly issues: readonly [] }
  | { readonly ok: false; readonly content: null; readonly issues: readonly ContentIssue[] };

export class ContentValidationError extends Error {
  constructor(public readonly issues: readonly ContentIssue[]) {
    super(`content validation failed with ${issues.length} issue(s):\n${formatIssues(issues)}`);
    this.name = 'ContentValidationError';
  }
}

export function formatIssues(issues: readonly ContentIssue[]): string {
  return issues
    .map((issue) => `  - [${issue.file ?? 'content'}] ${issue.path}: ${issue.message}`)
    .join('\n');
}

/**
 * Validate a raw content bundle: per-file zod schemas, then duplicate ids, then
 * cross-file reference integrity. Never throws — see {@link loadContent}.
 */
export function validateContent(raw: RawContent): ContentValidation {
  const issues: ContentIssue[] = [];
  const parsed: Record<string, unknown> = {};

  for (const file of CONTENT_FILE_NAMES) {
    const result = CONTENT_FILE_SCHEMAS[file].safeParse(raw[file]);
    if (result.success) {
      parsed[file] = result.data;
      continue;
    }
    for (const issue of result.error.issues) {
      issues.push({
        file,
        path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
        message: issue.message,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, content: null, issues };
  }

  const content = parsed as Content;

  for (const duplicate of findDuplicateIds(content)) {
    issues.push({
      file: null,
      path: duplicate.collection,
      message: `duplicate id "${duplicate.id}"`,
    });
  }
  for (const refIssue of checkContentRefs(content)) {
    issues.push({ file: null, path: refIssue.path, message: formatRefIssue(refIssue) });
  }

  if (issues.length > 0) {
    return { ok: false, content: null, issues };
  }
  return { ok: true, content, issues: [] };
}

/** Validating loader used by the sim, the tools and the editor. Throws on invalid content. */
export function loadContent(raw: RawContent): Content {
  const validation = validateContent(raw);
  if (!validation.ok) {
    throw new ContentValidationError(validation.issues);
  }
  return validation.content;
}

export function indexById<T extends { id: string }>(entries: readonly T[]): ReadonlyMap<string, T> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}
