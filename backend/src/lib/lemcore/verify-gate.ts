// Programmatic verification gate: before a lemcore run is allowed to finish,
// detect and run the project's test/build command and require exit 0. This
// closes the gap where the prompt-only "you MUST run tests" instruction
// (loop-constants.ts) was ignored by the model and the run finished with
// failing tests. Pattern: SWE-bench FAIL_TO_PASS / PASS_TO_PASS winners.
//
// On failure, the gate does NOT finish — it injects a Reflexion-style
// critique (Shinn et al. NeurIPS 2023) so the next attempt reasons about
// *why* the tests failed instead of blindly retrying.
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { truncate } from './tools.js';
import { logEvent } from '../agent-git.js';
import { config } from '../../config.js';
import type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';

const execFileAsync = promisify(execFile);
const GATE_TIMEOUT_MS = 120_000;
const FAILURE_OUTPUT_CHARS = 4_000;

/** After this many consecutive gate failures the run finishes anyway (avoids infinite loops). */
export const MAX_GATE_FAILURES = 3;

export interface VerifyResult {
  passed: boolean;
  /** True when no test/build setup was detected (gate skipped). */
  skipped: boolean;
  command: string | null;
  output: string;
}

/**
 * Auto-detect the project's verify command from its manifest files. Returns
 * null when no test setup is recognized — the gate is then skipped, matching
 * the prompt's "if the project has a test setup". Mirrors detectLintCommand's
 * pattern (edit-checkpoint.ts) but for whole-project test/build.
 */
export async function detectVerifyCommand(workdir: string): Promise<string | null> {
  const pkg = await readJson(path.join(workdir, 'package.json'));
  if (pkg && typeof pkg === 'object' && 'scripts' in pkg) {
    const scripts = (pkg as { scripts?: Record<string, unknown> }).scripts ?? {};
    if (typeof scripts.test === 'string' && scripts.test.trim()) return 'npm test';
    if (typeof scripts.build === 'string' && scripts.build.trim()) return 'npm run build';
  }
  if (await exists(path.join(workdir, 'pytest.ini')) || await hasPytestConfig(workdir)) {
    return 'python -m pytest -q';
  }
  if (await exists(path.join(workdir, 'go.mod'))) return 'go build ./... && go test ./...';
  if (await exists(path.join(workdir, 'Cargo.toml'))) return 'cargo test';
  if (await hasMakeTestTarget(workdir)) return 'make test';
  return null;
}

async function hasPytestConfig(workdir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(workdir, 'pyproject.toml'), 'utf8');
    return /\[tool\.pytest\]/.test(raw) || /\[pytest\]/.test(raw);
  } catch {
    return false;
  }
}

async function hasMakeTestTarget(workdir: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(workdir, 'Makefile'), 'utf8');
    return /^test:\s/m.test(raw);
  } catch {
    return false;
  }
}

/**
 * Detect the dependency-install command for Node projects (the only ecosystem
 * where deps aren't fetched by the build/test itself). Returns null for Go,
 * Cargo, etc. — `go test` and `cargo test` pull deps implicitly. The workdir
 * is a fresh clone, so node_modules is typically absent; without an install
 * step the gate would fail with "jest: not found" for every Node repo (C2).
 */
export async function detectInstallCommand(workdir: string): Promise<string | null> {
  const hasPkg = await exists(path.join(workdir, 'package.json'));
  if (!hasPkg) return null;
  if (await exists(path.join(workdir, 'package-lock.json'))) return 'npm ci';
  if (await exists(path.join(workdir, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (await exists(path.join(workdir, 'yarn.lock'))) return 'yarn install';
  return 'npm install';
}

/**
 * Run the detected verify command and return the outcome. For Node projects,
 * installs dependencies first (npm ci/install) when node_modules is absent —
 * a fresh clone otherwise fails with "test runner not found" (C2). Install
 * failures (e.g. worker has no Node) skip the gate rather than failing, so an
 * environment gap doesn't burn the retry budget.
 */
export async function runVerifyGate(
  workdir: string,
  taskId: string,
  timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<VerifyResult> {
  const command = await detectVerifyCommand(workdir);
  if (!command) {
    return { passed: true, skipped: true, command: null, output: '' };
  }
  const installResult = await maybeInstall(workdir, taskId, timeoutMs);
  if (installResult.skipped) return installResult;
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd: workdir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    await logEvent(taskId, `verify gate passed: ${command}`);
    return { passed: true, skipped: false, command, output: truncate(`${stdout}\n${stderr}`.trim() || '(no output)') };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    const raw = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (err as Error).message;
    const killed = e.killed && e.signal ? ` (timed out after ${Math.round(timeoutMs / 1000)}s — killed by ${e.signal})` : '';
    await logEvent(taskId, `verify gate FAILED (${command})${killed}`);
    return {
      passed: false,
      skipped: false,
      command,
      output: truncate(`${raw}${killed}`, FAILURE_OUTPUT_CHARS),
    };
  }
}

// Install deps when node_modules is absent. An install failure (no Node on
// the worker, registry down) skips the gate — punishing the model for an
// environment issue it can't fix would waste the retry budget.
async function maybeInstall(
  workdir: string,
  taskId: string,
  timeoutMs: number,
): Promise<VerifyResult | { skipped: false }> {
  const installCmd = await detectInstallCommand(workdir);
  if (!installCmd) return { skipped: false as const };
  if (await exists(path.join(workdir, 'node_modules'))) {
    await logEvent(taskId, 'verify gate: node_modules present, skipping install');
    return { skipped: false as const };
  }
  try {
    await logEvent(taskId, `verify gate: installing dependencies (${installCmd})`);
    await execFileAsync('sh', ['-c', installCmd], {
      cwd: workdir,
      timeout: Math.min(timeoutMs, 180_000),
      maxBuffer: 4 * 1024 * 1024,
    });
    return { skipped: false as const };
  } catch (err) {
    const msg = (err as Error).message;
    await logEvent(taskId, `verify gate: dependency install failed (${installCmd}) — skipping gate: ${msg}`);
    return {
      passed: true,
      skipped: true,
      command: null,
      output: `dependency install failed (${installCmd}): ${msg}`,
    };
  }
}

/**
 * Build a Reflexion-style critique message for a gate failure. The model is
 * asked to reflect on WHY the verification failed and what to change, rather
 * than blindly retrying. The critique is carried forward as a conversation
 * turn (bounds context vs. replaying the full failed trace).
 */
export function buildReflexionCritique(failureOutput: string, attempt: number): string {
  const isLast = attempt >= MAX_GATE_FAILURES;
  const warning = isLast
    ? `This is your LAST allowed attempt (${attempt}/${MAX_GATE_FAILURES}) — if verification fails again the run will finish with a warning.`
    : `Attempt ${attempt}/${MAX_GATE_FAILURES}.`;
  return [
    `[verify-gate] Your changes FAILED verification. ${warning}`,
    'Test/build output:',
    '```',
    failureOutput,
    '```',
    '',
    'Reflect briefly on WHY this failed and what specifically to change, then fix it.',
    'Do not just re-run the same command — identify the root cause first.',
  ].join('\n');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Loop integration: decide whether a 'final' reply may actually finish.
// ---------------------------------------------------------------------------

export type GateOutcome =
  | { kind: 'pass'; summary: string }
  | { kind: 'fail'; nextFailureCount: number; step: LemcoreStep };

/**
 * Called by the loop when the model emits a 'final' reply. When the verify
 * gate is enabled (implementation runs), runs the project's test/build command
 * and decides: pass → finish; fail → inject a Reflexion critique and continue
 * (up to MAX_GATE_FAILURES, after which the run finishes with a warning so it
 * can't loop forever). When the gate is disabled or no test setup exists, the
 * reply is accepted immediately (preserves the old behavior for review runs
 * and repos without tests).
 */
export async function checkVerifyGate(
  opts: LemcoreRunOptions,
  workdir: string,
  taskId: string,
  consecutiveFailures: number,
  messages: LemcoreMessage[],
  finalContent: string,
): Promise<GateOutcome> {
  if (!opts.verifyGate || !config.LEMCORE_VERIFY_GATE) {
    return { kind: 'pass', summary: finalContent };
  }
  const result = await runVerifyGate(workdir, taskId);
  if (result.passed) {
    // Return the bare summary — appending a gate banner leaks into the PR body
    // and the commit-message LLM prompt (H1). The pass/fail outcome is already
    // logged to the task log via logEvent inside runVerifyGate.
    return { kind: 'pass', summary: finalContent };
  }
  const attempt = consecutiveFailures + 1;
  const critique = buildReflexionCritique(result.output, attempt);
  messages.push({ role: 'user', content: critique });
  // Cap reached — finish anyway so the run doesn't loop forever. Surface a
  // ONE-LINE marker so reviewers know tests failed, but do NOT dump the raw
  // test log into the summary (it lands in the PR body / commit prompt). The
  // full failure output already went to the task log via logEvent.
  if (attempt >= MAX_GATE_FAILURES) {
    return {
      kind: 'pass',
      summary: `${finalContent}\n\n[verification incomplete: tests still failing after ${attempt} attempts — see task log, fix manually]`,
    };
  }
  return {
    kind: 'fail',
    nextFailureCount: attempt,
    step: {
      stepId: `verify-gate-${taskId}-${attempt}`,
      status: 'done',
      kind: 'assistant',
      title: `Verification failed (attempt ${attempt}/${MAX_GATE_FAILURES}) — nudging the model`,
      detail: critique.slice(0, 500),
      outputPreview: result.output.slice(0, 500),
    },
  };
}

async function readJson(p: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
