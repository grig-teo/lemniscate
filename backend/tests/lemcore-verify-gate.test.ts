import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// runVerifyGate calls logEvent (DB write) — stub it so the test stays unit-level.
vi.mock('../src/lib/agent-git.js', () => ({ logEvent: vi.fn(async () => {}) }));

import {
  detectVerifyCommand,
  runVerifyGate,
  buildReflexionCritique,
  checkVerifyGate,
  MAX_GATE_FAILURES,
} from '../src/lib/lemcore/verify-gate.js';
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

  it('finishes with a warning after MAX_GATE_FAILURES consecutive failures', async () => {
    await writeFile(
      path.join(workdir, 'package.json'),
      JSON.stringify({ scripts: { test: 'exit 1' } }),
    );
    const messages: LemcoreMessage[] = [];

    const outcome = await checkVerifyGate(
      baseOpts, workdir, 't4', MAX_GATE_FAILURES - 1, messages, 'I am done',
    );

    // Cap reached → must pass (finish) with a warning, not loop forever.
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') {
      expect(outcome.summary).toMatch(/still failing|fix manually/i);
    }
  });

  it('passes and appends a gate-passed note when tests are green', async () => {
    await writeFile(path.join(workdir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    const messages: LemcoreMessage[] = [];
    const outcome = await checkVerifyGate(baseOpts, workdir, 't5', 0, messages, 'done');
    expect(outcome.kind).toBe('pass');
    if (outcome.kind === 'pass') {
      expect(outcome.summary).toContain('npm test passed');
    }
  });
});
