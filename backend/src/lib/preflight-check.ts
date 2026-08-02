import { logEvent } from './agent-git.js';
import {
  llmCall,
  TokenBudgetExceededError,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { logger } from './logger.js';
import { setTaskStatus } from './task-events.js';

// Pre-flight "is this already done?" check. Runs once per fresh task before
// implementation: one small LLM call with the repo context digest (see
// repo-digest.ts) + the task text. When the requested change already exists
// on the default branch the task closes immediately as done — saving a full
// implementation run (and its retries) that would only re-derive the same
// code. A false negative costs nothing (the run proceeds as before); a false
// positive is visible in the task log with the model's evidence, and a rerun
// restarts the task.

export type PreflightVerdict = 'implement' | 'already_done' | 'partially_done';

export interface PreflightResult {
  verdict: PreflightVerdict;
  evidence: string;
}

export function parsePreflightVerdict(content: string): PreflightResult {
  const lines = content.trim().split('\n');
  const first = (lines[0] ?? '').trim().toLowerCase();
  const verdict: PreflightVerdict = first.includes('already_done')
    ? 'already_done'
    : first.includes('partially_done')
      ? 'partially_done'
      : 'implement';
  const evidence = lines.slice(1).join(' ').trim().slice(0, 300);
  return { verdict, evidence };
}

export function buildPreflightPrompt(title: string, prompt: string, digest: string): string {
  return [
    'Decide whether a coding task still needs implementation, using only the repository digest below (auto-generated from the default branch).',
    '',
    'Answer with EXACTLY ONE verdict on the first line: IMPLEMENT, ALREADY_DONE, or PARTIALLY_DONE, then one sentence of evidence (file/symbol names) on the second line.',
    'Use ALREADY_DONE only when the requested behavior is fully present on the default branch. When unsure, answer IMPLEMENT.',
    '',
    `# Repository digest\n${digest}`,
    '',
    `# Task title\n${title}`,
    '',
    `# Task description\n${prompt || '(no description)'}`,
  ].join('\n');
}

/**
 * One cheap verdict call; null when there is no digest to judge from or the
 * call fails (proceed with implementation in both cases). The token-budget
 * hard-stop is rethrown, matching the other auxiliary LLM calls.
 */
export async function preflightAlreadyDone(
  task: TaskWithRepo,
  rt: LlmRuntime,
): Promise<PreflightResult | null> {
  const digest = task.repository.contextDigest?.trim();
  if (!digest) return null;
  try {
    const content = await llmCall(rt, [
      { role: 'user', content: buildPreflightPrompt(task.title, task.prompt ?? '', digest) },
    ]);
    const result = parsePreflightVerdict(content);
    await logEvent(
      task.id,
      `pre-flight check: ${result.verdict}${result.evidence ? ` — ${result.evidence}` : ''}`,
    );
    return result;
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) throw err;
    logger.warn({ err, taskId: task.id }, 'pre-flight check failed; proceeding with implementation');
    return null;
  }
}

/**
 * Closes the task as done when the pre-flight verdict is ALREADY_DONE.
 * Returns true when the caller must stop the run (no implementation needed).
 */
export async function closeIfAlreadyDone(task: TaskWithRepo, rt: LlmRuntime): Promise<boolean> {
  const preflight = await preflightAlreadyDone(task, rt);
  if (preflight?.verdict !== 'already_done') return false;
  await setTaskStatus(task.id, 'done');
  return true;
}
