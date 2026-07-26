#!/usr/bin/env node
/**
 * CI guard for AGENTS.md section 2 ("split files that grow past ~300 lines"):
 * every module under src/ must stay at or below MAX_LINES. Run via
 * `npm run check:max-lines`; exits 1 listing the offenders.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LINES = 300;
const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

const offenders = [];
for (const file of sourceFiles(SRC_DIR)) {
  const lines = readFileSync(file, 'utf8').split('\n').length;
  if (lines > MAX_LINES) {
    offenders.push({ file: relative(SRC_DIR, file), lines });
  }
}

if (offenders.length > 0) {
  console.error(`Modules over ${MAX_LINES} lines (AGENTS.md section 2):`);
  for (const { file, lines } of offenders) {
    console.error(`  ${lines}\tsrc/${file}`);
  }
  process.exit(1);
}
console.log(`OK: every module under src/ is at or below ${MAX_LINES} lines.`);
