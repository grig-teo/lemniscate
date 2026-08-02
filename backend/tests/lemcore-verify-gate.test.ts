import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// runVerifyGate calls logEvent (DB write) — stub it so the test stays unit-level.
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: vi.fn(async () => {}) }));

import {
  detectVerifyCommand,
  detectInstallCommand,
  runVerifyGate,
  buildReflexionCritique,
  checkVerifyGate,
  MAX_GATE_FAILURES,
} from '../src/lib/lemcore/verify-gate.js';
import { setTodoList } from '../src/lib/lemcore/todo-store.js';
import type { LemcoreMessage, LemcoreRunOptions } from '../src/lib/lemcore/loop-types.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'lemcore-verify-'));
});

afterEach(async () => {
  await import('node:fs/promises').then((fs) => fs.rm(workdir, { recursive: true, force: true }));
});

describe('detectVerifyCommand', () => {
  it('detects npm test from package.json with a test script', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } }),
    );
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBe('npm test');
  });

  it('detects npm run build when there is no test script but a build script exists', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBe('npm run build');
  });

  it('returns null for a package.json with no test or build script', async () => {
    await writeFile(path.join(workdir, 'package.json'), JSON.stringify({ name: 'x' }));
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBeNull();
  });

  it('detects pytest from pyproject.toml', async () => {
    await writeFile(path.join(workdir, 'pyproject.toml'), '[tool.pytest]\n');
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBe('python -m pytest -q');
  });

  it('detects go test from go.mod', async () => {
    await writeFile(path.join(workdir, 'go.mod'), 'module example.com/x\n\ngo 1.21\n');
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBe('go build ./... && go test ./...');
  });

  it('detects cargo test from Cargo.toml', async () => {
    await writeFile(path.join(workdir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBe('cargo test');
  });

  it('returns null when no recognized manifest exists', async () => {
    await writeFile(path.join(workdir, 'README.md'), '# hello');
    const cmd = await detectVerifyCommand(workdir);
    expect(cmd).toBeNull();
  });
});

describe('detectInstallCommand', () => {
  it('detects npm ci when package-lock.json exists', async () => {
    await writeFile(path.join(workdir, 'package.json'), '{}');
    await writeFile(path.join(workdir, 'package-lock.json'), '{}');
    expect(await detectInstallCommand(workdir)).toBe('npm ci');
  });

  it('detects npm install when only package.json exists (no lockfile)', async () => {
    await writeFile(path.join(workdir, 'package.json'), '{}');
    expect(await detectInstallCommand(workdir)).toBe('npm install');
  });

  it('returns null for non-Node projects (deps fetched by build/test)', async () => {
    await writeFile(path.join(workdir, 'go.mod'), 'module x\n');
    expect(await detectInstallCommand(workdir)).toBeNull();
    await writeFile(path.join(workdir, 'Cargo.toml'), '[package]\n');
    expect(await detectInstallCommand(workdir)).toBeNull();
  });
});

describe('runVerifyGate — install-before-test (C2)', () => {
  it('runs npm install before the test command when node_modules is absent', async () => {
    // The install step must run before the test. We detect this by putting a
    // fake `npm` on PATH that, on `npm ci`/`npm install`, creates the
    // node_modules/INSTALLED marker. The test "command" is a direct shell
    // check (not `npm test`, which would need the real npm to run the script).
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'true' } }),
    );
    const fakeBinDir = path.join(workdir, '.fakebin');
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(
      path.join(fakeBinDir, 'npm'),
      [
        '#!/bin/sh',
        '# Fake npm: install creates the marker; test/run are no-ops (exit 0).',
        'case "$1" in',
        '  ci|install) mkdir -p node_modules && echo ok > node_modules/INSTALLED ;;',
        '  test|run) exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    );
    await import('node:fs/promises').then((fs) => fs.chmod(path.join(fakeBinDir, 'npm'), 0o755));
    const prevPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}:${prevPath}`;
    try {
      const result = await runVerifyGate(workdir, 't-install');
      expect(result.passed).toBe(true);
      // The fake npm created node_modules/INSTALLED during the install step.
      const installed = await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(workdir, 'node_modules', 'INSTALLED'), 'utf8').catch(() => 'MISSING'),
      );
      expect(installed).toContain('ok');
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('skips install when node_modules already exists', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo NO_INSTALL_RAN' } }),
    );
    await mkdir(path.join(workdir, 'node_modules'), { recursive: true });
    const result = await runVerifyGate(workdir, 't-skip-install');
    expect(result.passed).toBe(true);
    expect(result.output).toContain('NO_INSTALL_RAN');
  });
});

describe('runVerifyGate', () => {
  it('passes when the command exits 0', async () => {
    await writeFile(path.join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    const result = await runVerifyGate(workdir, 't1');
    expect(result.passed).toBe(true);
    expect(result.command).toBe('npm test');
  });

  it('fails when the command exits non-zero', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "FAIL: expected 5 got 3" && exit 1' } }),
    );
    const result = await runVerifyGate(workdir, 't2');
    expect(result.passed).toBe(false);
    expect(result.command).toBe('npm test');
    expect(result.output).toContain('FAIL: expected 5 got 3');
  });

  it('skips (passed=true, skipped=true) when no test command is detected', async () => {
    await writeFile(path.join(workdir, 'README.md'), 'no tests here');
    const result = await runVerifyGate(workdir, 't3');
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.command).toBeNull();
  });

  it('marks timeout as a failure', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'sleep 30' } }),
    );
    const result = await runVerifyGate(workdir, 't4', 1_000);
    expect(result.passed).toBe(false);
    expect(result.output).toMatch(/timed out|killed/i);
  });
});

describe('buildReflexionCritique', () => {
  it('builds a critique message that asks the model to reflect on the failure', () => {
    const msg = buildReflexionCritique('FAIL: expected 5 got 3', 1);
    expect(msg).toContain('Reflect');
    expect(msg).toMatch(/attempt 1/i);
    expect(msg).toContain('FAIL: expected 5 got 3');
  });

  it('includes the attempt number for escalation awareness', () => {
    const msg = buildReflexionCritique('error', 2);
    expect(msg).toMatch(/attempt 2/i);
  });

  it('warns on the final attempt', () => {
    const msg = buildReflexionCritique('error', MAX_GATE_FAILURES);
    expect(msg).toMatch(/last allowed|final/i);
  });
});

describe('checkVerifyGate — TODO gate: CI/review wait for a done list', () => {
  it('blocks the finish while any TODO item is unchecked (even with the verify gate off)', async () => {
    setTodoList(workdir, '- [ ] implement endpoint\n- [x] read the docs');
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(
      { verifyGate: false } as LemcoreRunOptions,
      workdir, 'tg1', 0, messages, 'I am done',
    );

    expect(outcome.kind).toBe('fail');
    if (outcome.kind === 'fail') {
      expect(outcome.nextFailureCount).toBe(1);
      expect(outcome.step.title).toMatch(/TODO list incomplete/);
    }
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('implement endpoint');
    expect(messages[0]!.content).toMatch(/CI checks, code review and finishing are blocked/);
  });

  it('lets the finish through once every item is checked', async () => {
    setTodoList(workdir, '- [x] implement endpoint\n- [x] read the docs');
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(
      { verifyGate: false } as LemcoreRunOptions,
      workdir, 'tg2', 0, messages, 'I am done',
    );

    expect(outcome.kind).toBe('pass');
    expect(messages).toHaveLength(0);
  });

  it('stops nudging once the shared failure budget is spent', async () => {
    setTodoList(workdir, '- [ ] stuck item');
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(
      { verifyGate: false } as LemcoreRunOptions,
      workdir, 'tg3', MAX_GATE_FAILURES, messages, 'I am done',
    );

    expect(outcome.kind).toBe('pass');
    expect(messages).toHaveLength(0);
  });
});

describe('checkVerifyGate — loop integration (Feature 1 + 2)', () => {
  const baseOpts = { verifyGate: true } as LemcoreRunOptions;

  it('passes through when the gate is disabled (review runs)', async () => {
    const messages: LemcoreMessage[] = [];
    const outcome = await checkVerifyGate(
      { verifyGate: false } as LemcoreRunOptions,
      workdir, 't1', 0, messages, 'I am done',
    );
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') expect(outcome.summary).toBe('I am done');
    expect(messages).toHaveLength(0); // no critique injected
  });

  it('passes when no test setup is detected (gate skipped)', async () => {
    await writeFile(path.join(workdir, 'README.md'), 'no tests');
    const messages: LemcoreMessage[] = [];
    const outcome = await checkVerifyGate(baseOpts, workdir, 't2', 0, messages, 'done');
    expect(outcome.kind).toBe('pass');
  });

  it('blocks the finish and injects a Reflexion critique when tests fail', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "AssertionError: 3 !== 5" && exit 1' } }),
    );
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(baseOpts, workdir, 't3', 0, messages, 'I am done');

    expect(outcome.kind).toBe('fail');
    if (outcome.kind === 'fail') {
      expect(outcome.nextFailureCount).toBe(1);
      expect(outcome.step.title).toMatch(/verification failed/i);
    }
    // The Reflexion critique was injected as a user message.
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('Reflect');
    expect(messages[0]!.content).toContain('AssertionError: 3 !== 5');
  });

  it('finishes with a ONE-LINE warning after MAX_GATE_FAILURES (no log dump in summary — H1)', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo BIG_FAILURE_LOG && exit 1' } }),
    );
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(
      baseOpts, workdir, 't4', MAX_GATE_FAILURES - 1, messages, 'I am done',
    );

    // Cap reached → must pass (finish) with a warning, not loop forever.
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') {
      // The summary carries a one-line marker so reviewers know tests failed,
      // but NOT the raw test log (that goes to the task log via logEvent).
      expect(outcome.summary).toMatch(/tests still failing|fix manually/i);
      expect(outcome.summary).not.toContain('BIG_FAILURE_LOG');
      // The original finalContent is preserved.
      expect(outcome.summary).toContain('I am done');
    }
  });

  it('returns a CLEAN summary (no gate banner) when tests are green (H1)', async () => {
    await writeFile(path.join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    const messages: LemcoreMessage[] = [];
    const outcome = await checkVerifyGate(baseOpts, workdir, 't5', 0, messages, 'done');
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') {
      // The pass path must NOT append gate banners to the summary — they leak
      // into the PR body and commit-message prompt.
      expect(outcome.summary).toBe('done');
      expect(outcome.summary).not.toContain('verify-gate');
    }
  });
});
