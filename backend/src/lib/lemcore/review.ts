import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  commitAndPush,
  hasDirtyWorkdir,
  logEvent,
  checkoutTaskBranch,
  type GitAuth,
} from '../agent-git.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { continueOrFinishReview } from '../review-finish.js';
import { fetchReviewDiff, requestReview } from '../agent-review.js';
import { runLemcoreLoop } from './loop.js';
import {
  buildHermesReviewPrompt,
  buildHermesFixPrompt,
  HERMES_REVIEW_FILENAME,
  parsePrReview,
  type PrReview,
} from '../pr-review.js';

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
    review = await requestReview(rt, task, await fetchReviewDiff(task, headBranch));
  }

  await logReview(task.id, review, rt.usedTokens);
  // Shared finish path with hermes/internal (review-finish.ts): must actually
  // enqueueReviewTask on changes_requested — the previous lemcore-only copy
  // only logged "queued re-review" and left the task stuck in reviewing_code.
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
