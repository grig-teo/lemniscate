import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs, run, formatReport, globToRegex } from './check-max-lines.mjs';

let tmpDir;

function lines(n) {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
}

/** Returns the path string the script would use for a file under tmpDir. */
function relPath(name) {
  return relative('.', join(tmpDir, name));
}

describe('parseArgs', () => {
  it('parses defaults', () => {
    const opts = parseArgs(['src']);
    assert.equal(opts.maxLines, 300);
    assert.deepEqual(opts.exts, ['ts', 'tsx']);
    assert.equal(opts.ignoreFile, null);
    assert.deepEqual(opts.excludes, []);
    assert.deepEqual(opts.dirs, ['src']);
  });

  it('parses all options', () => {
    const opts = parseArgs([
      'src', 'lib',
      '--max-lines', '200',
      '--ext', 'ts,js',
      '--ignore', 'baseline.json',
      '--exclude', '*.test.*',
      '--exclude', '*.spec.*',
    ]);
    assert.equal(opts.maxLines, 200);
    assert.deepEqual(opts.exts, ['ts', 'js']);
    assert.equal(opts.ignoreFile, 'baseline.json');
    assert.deepEqual(opts.excludes, ['*.test.*', '*.spec.*']);
    assert.deepEqual(opts.dirs, ['src', 'lib']);
  });
});

describe('globToRegex', () => {
  it('matches simple wildcard', () => {
    const rx = globToRegex('*.test.*');
    assert.ok(rx.test('foo.test.js'));
    assert.ok(rx.test('bar.test.ts'));
    assert.ok(!rx.test('foo.ts'));
  });

  it('matches path segments', () => {
    const rx = globToRegex('**/*.test.*');
    assert.ok(rx.test('dir/sub/foo.test.js'));
  });
});

describe('run — compliant fixture', () => {
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'cml-ok-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('passes when all files are under the limit', () => {
    writeFileSync(join(tmpDir, 'small.ts'), lines(50));
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'ok.tsx'), lines(200));

    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts', 'tsx'], ignoreFile: null, excludes: [] });
    assert.equal(result.violations.length, 0);
  });

  it('reports OK message', () => {
    writeFileSync(join(tmpDir, 'ok.ts'), lines(10));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: null, excludes: [] });
    assert.ok(formatReport(result).includes('OK'));
  });
});

describe('run — oversized fixture', () => {
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'cml-big-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('fails when a file exceeds the limit', () => {
    writeFileSync(join(tmpDir, 'huge.ts'), lines(350));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: null, excludes: [] });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].reason, 'over-limit');
    assert.equal(result.violations[0].lines, 350);
  });

  it('reports the offending file in output', () => {
    writeFileSync(join(tmpDir, 'big.ts'), lines(400));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: null, excludes: [] });
    const report = formatReport(result);
    assert.ok(report.includes('FAIL'));
    assert.ok(report.includes('big.ts'));
  });

  it('detects multiple offenders across directories', () => {
    mkdirSync(join(tmpDir, 'a'));
    mkdirSync(join(tmpDir, 'b'));
    writeFileSync(join(tmpDir, 'a', 'x.ts'), lines(310));
    writeFileSync(join(tmpDir, 'b', 'y.ts'), lines(320));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: null, excludes: [] });
    assert.equal(result.violations.length, 2);
  });
});

describe('run — exclude patterns', () => {
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'cml-exc-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('skips excluded test files', () => {
    writeFileSync(join(tmpDir, 'lib.test.js'), lines(500));
    writeFileSync(join(tmpDir, 'ok.js'), lines(50));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['js'], ignoreFile: null, excludes: ['*.test.*'] });
    assert.equal(result.violations.length, 0);
  });
});

describe('run — baseline (grandfather) semantics', () => {
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'cml-base-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('passes when a grandfathered file is shrinking or stable', () => {
    writeFileSync(join(tmpDir, 'big.ts'), lines(350));
    const baselineFile = join(tmpDir, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify([
      { path: relPath('big.ts'), lines: 400, date: '2026-07-26' },
    ]));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: baselineFile, excludes: [] });
    assert.equal(result.violations.length, 0);
  });

  it('fails when a grandfathered file grew beyond its baseline', () => {
    writeFileSync(join(tmpDir, 'grew.ts'), lines(450));
    const baselineFile = join(tmpDir, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify([
      { path: relPath('grew.ts'), lines: 400, date: '2026-07-26' },
    ]));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: baselineFile, excludes: [] });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].reason, 'grew');
    assert.equal(result.violations[0].wasLines, 400);
  });

  it('fails for a new offender not in the baseline', () => {
    writeFileSync(join(tmpDir, 'new.ts'), lines(350));
    const baselineFile = join(tmpDir, 'baseline.json');
    writeFileSync(baselineFile, '[]');
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: baselineFile, excludes: [] });
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].reason, 'over-limit');
  });

  it('flags stale baseline entries for removal', () => {
    writeFileSync(join(tmpDir, 'fixed.ts'), lines(100));
    const baselineFile = join(tmpDir, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify([
      { path: relPath('fixed.ts'), lines: 350, date: '2026-07-26' },
    ]));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: baselineFile, excludes: [] });
    assert.equal(result.violations.length, 0);
    assert.ok(result.staleEntries.size > 0);
  });

  it('reports stale entries in output', () => {
    writeFileSync(join(tmpDir, 'fixed.ts'), lines(100));
    const baselineFile = join(tmpDir, 'baseline.json');
    writeFileSync(baselineFile, JSON.stringify([
      { path: relPath('fixed.ts'), lines: 350, date: '2026-07-26' },
    ]));
    const result = run({ dirs: [tmpDir], maxLines: 300, exts: ['ts'], ignoreFile: baselineFile, excludes: [] });
    assert.ok(formatReport(result).includes('WARNING'));
  });
});
