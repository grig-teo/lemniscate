#!/usr/bin/env node

/**
 * CI guard for AGENTS.md sections 1–2:
 *   - "split files that grow past ~300 lines" (§2, file/module limit)
 *   - "Keep functions under 20 lines / never exceed 50" (§1, function limit)
 *
 * This script enforces the FILE-level limit (§2).  Function-level enforcement
 * would require AST parsing and is left to linters; the line-count gate is the
 * cheap, dependency-free backstop that catches the worst offenders before they
 * land.
 *
 * Usage:
 *   node check-max-lines.mjs <dir...> [options]
 *
 * Options:
 *   --max-lines <n>     Max lines per file (default: 300)
 *   --ext <exts>        Comma-separated extensions, no dot (default: ts,tsx)
 *   --ignore <file>     JSON baseline of grandfathered offenders (see below)
 *   --exclude <pat>     Glob pattern to exclude, relative to scan dir
 *                       (repeatable; e.g. --exclude '*.test.*')
 *
 * Exit codes:
 *   0  all files within limit (or shrinking inside the baseline)
 *   1  at least one file violates the limit
 *
 * Baseline file format (JSON array):
 *   [
 *     { "path": "src/lib/huge.ts", "lines": 429, "date": "2026-07-26" }
 *   ]
 *
 * Semantics — the baseline is monotonic-decreasing:
 *   - A file in the baseline passes only if its CURRENT line count is ≤ the
 *     recorded value.  If it grew, the check fails (no silent regression).
 *   - A file NOT in the baseline that exceeds --max-lines always fails.
 *   - A baseline entry whose file is now under the limit emits a warning so
 *     it can be removed — the list can only shrink.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const dirs = [];
  const excludes = [];
  let maxLines = 300;
  let exts = ['ts', 'tsx'];
  let ignoreFile = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-lines') { maxLines = parseInt(argv[++i], 10); }
    else if (arg === '--ext') { exts = argv[++i].split(',').map(e => e.trim()); }
    else if (arg === '--ignore') { ignoreFile = argv[++i]; }
    else if (arg === '--exclude') { excludes.push(argv[++i]); }
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`);
      process.exit(2);
    } else {
      dirs.push(arg);
    }
  }

  if (dirs.length === 0) {
    console.error('Usage: check-max-lines.mjs <dir...> [--max-lines N] [--ext ts,tsx] [--ignore file] [--exclude pat]');
    process.exit(2);
  }

  return { dirs, maxLines, exts, ignoreFile, excludes };
}

// ---------------------------------------------------------------------------
// Glob matching (minimal — supports * and **)
// ---------------------------------------------------------------------------

function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function isExcluded(filePath, patterns) {
  if (patterns.length === 0) return false;
  const name = basename(filePath);
  return patterns.some(p => {
    const rx = globToRegex(p);
    return rx.test(name) || rx.test(filePath);
  });
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function* walkDir(dir, exts, excludes) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkDir(fullPath, exts, excludes);
    } else {
      const ext = entry.split('.').slice(1).join('.');
      if (!exts.includes(ext)) continue;
      if (isExcluded(fullPath, excludes)) continue;
      yield fullPath;
    }
  }
}

function countLines(filePath) {
  return readFileSync(filePath, 'utf8').split('\n').length;
}

// ---------------------------------------------------------------------------
// Baseline handling
// ---------------------------------------------------------------------------

function loadBaseline(ignoreFile) {
  if (!ignoreFile || !existsSync(ignoreFile)) return new Map();
  const raw = readFileSync(ignoreFile, 'utf8');
  const entries = JSON.parse(raw);
  const map = new Map();
  for (const e of entries) {
    map.set(e.path, { lines: e.lines, date: e.date, reason: e.reason });
  }
  return map;
}

function checkBaselineEntry(relPath, currentLines, baseline) {
  const entry = baseline.get(relPath);
  if (!entry) return { ok: false, reason: 'not-in-baseline' };
  if (currentLines <= entry.lines) {
    return { ok: true, reason: 'shrinking', wasLines: entry.lines };
  }
  return { ok: false, reason: 'grew', wasLines: entry.lines };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(opts) {
  const { dirs, maxLines, exts, ignoreFile, excludes } = opts;
  const baseline = loadBaseline(ignoreFile);

  const violations = [];
  const staleEntries = new Set(baseline.keys());

  for (const dir of dirs) {
    for (const file of walkDir(dir, exts, excludes)) {
      const relPath = relative('.', file);
      const lines = countLines(file);
      const inBaseline = baseline.has(relPath);

      if (lines <= maxLines) {
        // File is fine. If it's still in the baseline, leave it flagged as
        // stale so it can be cleaned up. Otherwise just skip.
        continue;
      }

      // File is over the limit — if it's in the baseline it's still actively
      // grandfathered, so remove it from the stale set.
      staleEntries.delete(relPath);

      if (!inBaseline) {
        violations.push({ file: relPath, lines, maxLines, reason: 'over-limit' });
        continue;
      }

      const check = checkBaselineEntry(relPath, lines, baseline);
      if (!check.ok) {
        violations.push({
          file: relPath, lines, maxLines,
          reason: check.reason,
          wasLines: check.wasLines,
        });
      }
    }
  }

  return { violations, staleEntries, maxLines, baselineSize: baseline.size };
}

function formatReport(result) {
  const { violations, staleEntries, maxLines } = result;
  const lines = [];

  if (violations.length > 0) {
    lines.push(`\nFAIL: ${violations.length} file(s) violate the ${maxLines}-line limit (AGENTS.md section 2):\n`);
    for (const v of violations) {
      if (v.reason === 'over-limit') {
        lines.push(`  ${v.lines}\t${v.file}`);
      } else if (v.reason === 'grew') {
        lines.push(`  ${v.lines}\t${v.file}  (was ${v.wasLines} in baseline — file GREW)`);
      }
    }
  }

  if (staleEntries.size > 0) {
    lines.push(`\nWARNING: ${staleEntries.size} baseline entr(y)ies are now under the limit and can be removed:`);
    for (const p of staleEntries) {
      lines.push(`  ${p}`);
    }
  }

  if (violations.length === 0 && staleEntries.size === 0) {
    lines.push(`OK: every module is at or below ${maxLines} lines.`);
  }

  return lines.join('\n');
}

// Run only when invoked directly, not when imported by tests
const isMain = process.argv[1] && process.argv[1].endsWith('check-max-lines.mjs');
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const result = run(opts);
  console.log(formatReport(result));
  process.exit(result.violations.length > 0 ? 1 : 0);
}

export { parseArgs, run, formatReport, walkDir, countLines, globToRegex, loadBaseline, checkBaselineEntry };
