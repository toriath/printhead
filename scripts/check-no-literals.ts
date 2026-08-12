/**
 * CI guard for spec §11: "no gameplay-numeric literals in `systems/`".
 *
 * Systems are generic interpreters of content definitions, so any number they
 * contain is a balance value that escaped `content/*.json`. Only 0 and 1 are
 * allowed (identities, off-by-one arithmetic, array stepping).
 *
 * Implemented on the TypeScript AST rather than a grep so that numbers inside
 * strings, comments and type positions do not produce false hits.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYSTEMS_DIR = join(ROOT, 'packages/core/src/systems');
const ALLOWED = new Set([0, 1]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function checkFile(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];

  const report = (node: ts.Node, literal: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({
      file: relative(ROOT, file),
      line: line + 1,
      column: character + 1,
      text: literal,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isNumericLiteral(node)) {
      const value = Number(node.text);
      if (!ALLOWED.has(value)) {
        report(node, node.getText(source));
      }
    } else if (ts.isBigIntLiteral(node)) {
      report(node, node.getText(source));
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

function main(): void {
  const files = listSourceFiles(SYSTEMS_DIR);
  const violations = files.flatMap(checkFile);

  if (violations.length > 0) {
    console.error('Numeric literals found in packages/core/src/systems (spec §11):');
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} → ${violation.text}`,
      );
    }
    console.error('\nMove the value into packages/core/content/*.json and read it from the def.');
    process.exit(1);
  }

  console.log(
    `no-literals: OK — ${files.length} file(s) in core/src/systems contain only 0/1 literals`,
  );
}

main();
