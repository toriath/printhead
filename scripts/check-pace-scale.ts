/**
 * CI guard for spec §8: `paceScale` is computed and applied in EXACTLY ONE
 * place — `packages/core/src/engine/pace.ts`. Everything else must go through
 * the `PaceMapping` it returns.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEARCH_ROOTS = ['packages', 'tools'];
const ALLOWED_FILES = new Set(['packages/core/src/engine/pace.ts']);
const NEEDLE = /paceScale/;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const offenders: string[] = [];
  for (const root of SEARCH_ROOTS) {
    for (const file of listFiles(join(ROOT, root))) {
      const rel = relative(ROOT, file);
      if (ALLOWED_FILES.has(rel)) {
        continue;
      }
      if (NEEDLE.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel);
      }
    }
  }

  if (offenders.length > 0) {
    console.error('paceScale must only be computed in packages/core/src/engine/pace.ts (spec §8):');
    for (const offender of offenders) {
      console.error(`  ${offender}`);
    }
    console.error('\nUse the PaceMapping returned by createPaceMapping instead.');
    process.exit(1);
  }

  console.log('pace-scale: OK — paceScale is applied in exactly one place');
}

main();
