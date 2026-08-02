import path from 'node:path';
import { hasMeaningfulChanges } from '../workdir-changes.js';
import { promises as fs } from 'node:fs';
import {
  commitAndPush,
  logEvent,
  checkoutTaskBranch,
  type GitAuth,
} from '../agent-git.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { continueOrFinishReview } from '../review-finish.js';
import { fetchReviewDiff, requestReview } from '../agent-review.js';
import { loadTranscript, runLemcoreLoop } from './loop.js';
import {
  buildAgentReviewPrompt,
  buildAgentFixPrompt,
  AGENT_REVIEW_FILENAME,
  parsePrReview,
  type PrReview,
} from '../pr-review.js';
import { PROMPT_INJECTION_GUARD, SECRETS_HANDLING_GUARD } from '../prompt-guards.js';

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

  const prompt = buildAgentReviewPrompt({
    taskTitle: task.title,
    taskPrompt: task.prompt,
    baseBranch: task.repository.defaultBranch,
    headBranch,
    systemPromptExtra: rt.cfg.systemPromptExtra,
  });

  // A re-enqueued review (worker restart, stuck-review recovery) continues
  // from the saved transcript instead of re-exploring from zero — reusing
  // one workdir + transcript across review loops, not three fresh ones.
  const resumeTranscript = loadTranscript(workdir) ?? undefined;
  if (resumeTranscript) {
    await logEvent(task.id, `resuming review from transcript (${resumeTranscript.length} messages)`);
  }
  await runLemcoreLoop({
    taskId: task.id,
    task,
    workdir,
    rt,
    prompt,
    secrets,
    resumeTranscript,
    // The default lemcoreSystemPrompt says "Implement the task completely,
    // including tests..." — contradictory during a review pass. Use a
    // review-specific system prompt so the agent only examines and writes its
    // verdict rather than implementing features.
    systemPromptOverride: [
      'You are reviewing a pull request. Examine the changes, read affected files, ' +
        'and write your verdict to .lemniscate-review.json. Do NOT implement new features.',
      PROMPT_INJECTION_GUARD,
      SECRETS_HANDLING_GUARD,
    ].join('\n'),
  });

  let review: PrReview | null = null;
  const reviewFile = path.join(workdir, AGENT_REVIEW_FILENAME);
  try {
    const raw = await fs.readFile(reviewFile, 'utf8');
    review = parsePrReview(raw);
    await fs.rm(reviewFile, { force: true });
  } catch {
    await logEvent(
      task.id,
      `no valid ${AGENT_REVIEW_FILENAME} from lemcore, falling back to a direct LLM review`,
    );
    review = await requestReview(rt, task, await fetchReviewDiff(task, headBranch));
  }

  await logReview(task.id, review, rt.usedTokens);
  // Shared finish path (review-finish.ts): single review pass — on
  // changes_requested the fix is applied once, then the PR is handed to the
  // merge gate / manual review (no re-review loop).
  await continueOrFinishReview(task, rt, review, () =>
    runLemcoreFixIteration(task, rt, review, headBranch, workdir, secrets, auth),
  );
  return rt;
}

// Also called directly by agent-review's applyReviewFixes (the fix tail
// shared with the address-review job): the branch is already checked out in
// `workdir`, so the agent fixes the review issues and pushes to the branch.
export async function runLemcoreFixIteration(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await logEvent(task.id, 'applying review fixes with the lemcore agent');
  const prompt = buildAgentFixPrompt({
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

  if (!(await hasMeaningfulChanges(workdir))) {
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
