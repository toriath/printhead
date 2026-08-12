/**
 * `pnpm content:check` — validates `packages/core/content/*.json` against the
 * zod schemas, then checks id uniqueness and every cross-reference (spec §11).
 * Reads the files from disk rather than the bundled import so that a JSON file
 * the loader forgot to wire up still gets checked.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_FILE_NAMES,
  type ContentFileName,
  type RawContent,
  formatIssues,
  validateContent,
} from '@printhead/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENT_DIR = join(ROOT, 'packages/core/content');

function readContentDir(): { raw: RawContent; extras: string[]; missing: string[] } {
  const present = new Set(
    readdirSync(CONTENT_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, '')),
  );
  const raw = {} as Record<ContentFileName, unknown>;
  const missing: string[] = [];
  for (const name of CONTENT_FILE_NAMES) {
    if (!present.has(name)) {
      missing.push(`${name}.json`);
      continue;
    }
    raw[name] = JSON.parse(readFileSync(join(CONTENT_DIR, `${name}.json`), 'utf8'));
    present.delete(name);
  }
  return { raw, extras: [...present].map((name) => `${name}.json`), missing };
}

function main(): void {
  const { raw, extras, missing } = readContentDir();

  if (missing.length > 0) {
    console.error(`content: missing required file(s): ${missing.join(', ')}`);
    process.exit(1);
  }
  if (extras.length > 0) {
    console.error(`content: ${extras.join(', ')} has no schema — add one in core/src/content`);
    process.exit(1);
  }

  const validation = validateContent(raw);
  if (!validation.ok) {
    console.error(`content: ${validation.issues.length} issue(s)`);
    console.error(formatIssues(validation.issues));
    process.exit(1);
  }

  const { content } = validation;
  console.log(
    [
      'content: OK —',
      `${CONTENT_FILE_NAMES.length} files,`,
      `${content.curves.length} curves,`,
      `${content.materials.length} materials,`,
      `${content.objects.length} objects,`,
      `${content.printers.length} printers,`,
      `${content.upgrades.length} upgrades,`,
      `${content.designs.length} designs,`,
      `${content.automation.length} automations,`,
      `${content.pacing.phases.length} phases`,
      `(targetHours=${content.pacing.targetHours})`,
    ].join(' '),
  );
}

main();
