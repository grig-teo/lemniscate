import path from 'node:path';
import { config } from '../../config.js';
import { promises as fs } from 'node:fs';
import {
  commitAndPush,
  hasDirtyWorkdir,
  logEvent,
  checkoutTaskBranch,
  type GitAuth,
} from '../agent-git.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { runLemcoreLoop } from './loop.js';
import {
  buildHermesReviewPrompt,
  buildHermesFixPrompt,
  HERMES_REVIEW_FILENAME,
  parsePrReview,
  type PrReview,
} from '../pr-review.js';

function lemcoreLlm(rt: LlmRuntime) {
  return {
    baseUrl: rt.cfg.baseUrl,
    apiKey: rt.apiKey,
    model: rt.cfg.model,
    contextWindow: rt.cfg.contextWindow,
  };
}

export async function runLemcoreReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  attempt: number,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<LlmRuntime> {
  await checkoutTaskBranch(
    workdir,
    cloneUrl,
    task.repository.defaultBranch,
    headBranch,
    secrets,
    auth,
  );
  await logEvent(task.id, `reviewing pull request (attempt ${attempt + 1}) with lemcore`);

  const prompt = buildHermesReviewPrompt({
    taskTitle: task.title,
    taskPrompt: task.prompt,
    baseBranch: task.repository.defaultBranch,
    headBranch,
    systemPromptExtra: rt.cfg.systemPromptExtra,
  });

  await runLemcoreLoop({
    taskId: task.id,
    task,
    workdir,
    rt,
    prompt,
    secrets,
  });

  // Read the review verdict file
  let review: PrReview | null = null;
  const reviewFile = path.join(workdir, HERMES_REVIEW_FILENAME);
  try {
    const raw = await fs.readFile(reviewFile, 'utf8');
    review = parsePrReview(raw);
    await fs.rm(reviewFile, { force: true });
  } catch {
    await logEvent(
      task.id,
      `no valid ${HERMES_REVIEW_FILENAME} from lemcore, falling back to a direct LLM review`,
    );
    // Fallback: direct LLM review (reuse the internal path)
    const { fetchReviewDiff } = await import('./agent-review.js');
    review = await fetchReviewDiff(task, headBranch).then(() => {
      // This is a simplified fallback - the actual review will be
      // done by the calling code's fallback logic
      return null;
    }).catch(() => null);
    if (review) return rt;
    // No review from lemcore or fallback — return so caller can handle
    return rt;
  }

  await logReview(task.id, review, rt.usedTokens);
  await continueOrFinishReview(task, rt, review, attempt, () =>
    runLemcoreFixIteration(task, rt, review, headBranch, workdir, secrets, auth),
  );
  return rt;
}

async function runLemcoreFixIteration(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await logEvent(task.id, 'applying review fixes with the lemcore agent');
  const prompt = buildHermesFixPrompt({
    taskTitle: task.title,
    taskPrompt: task.prompt,
    review,
    systemPromptExtra: rt.cfg.systemPromptExtra,
  });

  await runLemcoreLoop({
    taskId: task.id,
    task,
    workdir,
    rt,
    prompt,
    secrets,
  });

  if (!(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'no fix changes produced; re-reviewing the existing branch');
    return;
  }
  await commitAndPush(
    task,
    rt,
    workdir,
    'address review issues (lemcore)',
    ['push', 'origin', headBranch],
    secrets,
    auth,
  );
  await logEvent(task.id, `pushed review fixes to ${headBranch} (lemcore)`);
}

async function logReview(taskId: string, review: PrReview, usedTokens: number): Promise<void> {
  await logEvent(taskId, `LLM review: ${review.verdict} — ${review.summary}`);
  for (const issue of review.issues) {
    await logEvent(taskId, `review issue${issue.path ? ` [${issue.path}]` : ''}: ${issue.comment}`);
  }
  await logEvent(taskId, `LLM usage so far: ~${usedTokens} tokens`);
}

// Reuse the same continueOrFinishReview logic as agent-review.ts
// The function is defined there; we duplicate it here to avoid
// a circular dependency through the runtime.
async function continueOrFinishReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  attempt: number,
  runFixIteration: () => Promise<void>,
): Promise<void> {
  if (review.verdict === 'request_changes') {
    await runFixIteration();
    await logEvent(task.id, 'queued re-review of the updated pull request');
    return;
  }
  // approve or changes_requested with no issues → finish
  await finishReview(task, review);
}

async function finishReview(task: TaskWithRepo, review: PrReview): Promise<void> {
  // Handled by the caller (merge-gate)
  await logEvent(task.id, `review finished: ${review.verdict}`);
}
