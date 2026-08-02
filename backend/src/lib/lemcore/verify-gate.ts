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
 * Run the detected verify command and return the outcome. The command runs
 * in the workdir with a hard timeout. Output is truncated for the LLM nudge.
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
    if (result.skipped) return { kind: 'pass', summary: finalContent };
    return { kind: 'pass', summary: `${finalContent}\n\n[verify-gate: ${result.command} passed]` };
  }
  const attempt = consecutiveFailures + 1;
  const critique = buildReflexionCritique(result.output, attempt);
  messages.push({ role: 'user', content: critique });
  // Cap reached — finish anyway so the run doesn't loop forever; surface the
  // failure in the summary so the merge gate / reviewer sees it.
  if (attempt >= MAX_GATE_FAILURES) {
    return {
      kind: 'pass',
      summary: `${finalContent}\n\n[verify-gate: ${result.command} still failing after ${attempt} attempts — fix manually]\n${result.output}`,
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
