import path from 'node:path';
import type { Task } from '@prisma/client';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  applyChanges,
  checkoutTaskBranch,
  cleanupWorkdir,
  commitAndPush,
  hasDirtyWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  type GitAuth,
} from './agent-git.js';
import { buildSkillsSection, requestChanges, type LlmChangesResponse } from './agent-prompts.js';
import {
  llmCall,
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { requestReviewViaHermes, runHermesFixIteration } from './agent-review-hermes.js';
import { enqueueMergeGate, enqueueReviewTask } from './proposal-scheduler.js';
import { deferRateLimitedReview } from './review-defer.js';
import { setTaskStatus } from './task-events.js';
import { getPullRequestDiff } from './pull-requests.js';
import {
  buildFixUserPrompt,
  buildReviewMessages,
  HERMES_REVIEW_FILENAME,
  parsePrReview,
  type PrReview,
} from './pr-review.js';
import { buildRepoContext } from './repo-context.js';
import { loadAgentsMdTemplate, loadTaskSkills } from './task-skills.js';

// Job: review-pr — review → fix iterations → hand-off to the merge gate.
// Both phases run on the configured executor: 'hermes' uses the same agent
// CLI as the implementation run (verdict via a JSON file), 'internal' uses
// direct structured LLM calls. Merging lives in merge-gate.ts (CI-gated).

const MAX_REVIEW_FIX_ATTEMPTS = 3;
const MAX_REVIEW_DIFF_CHARS = 24_000;

async function requestReview(rt: LlmRuntime, task: Task, diff: string): Promise<PrReview> {
  const content = await llmCall(
    rt,
    buildReviewMessages({
      taskTitle: task.title,
      taskPrompt: task.prompt,
      diff,
      systemPromptExtra: rt.cfg.systemPromptExtra,
    }),
  );
  return parsePrReview(content);
}

async function fetchReviewDiff(task: TaskWithRepo, headBranch: string): Promise<string> {
  const { repository } = task;
  const rawDiff = await getPullRequestDiff(repository.connection, {
    repoFullName: repository.fullName,
    headBranch,
    baseBranch: repository.defaultBranch,
  });
  return rawDiff.length > MAX_REVIEW_DIFF_CHARS
    ? `${rawDiff.slice(0, MAX_REVIEW_DIFF_CHARS)}\n… [truncated]`
    : rawDiff;
}

async function logReview(taskId: string, review: PrReview, usedTokens: number): Promise<void> {
  await logEvent(taskId, `LLM review: ${review.verdict} — ${review.summary}`);
  for (const issue of review.issues) {
    await logEvent(taskId, `review issue${issue.path ? ` [${issue.path}]` : ''}: ${issue.comment}`);
  }
  await logEvent(taskId, `LLM usage so far: ~${usedTokens} tokens`);
}

// ---------------------------------------------------------------------------
// Review-fix iteration
// ---------------------------------------------------------------------------

async function proposeFixes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  workdir: string,
): Promise<LlmChangesResponse> {
  const agentsMdTemplate = await loadAgentsMdTemplate(task.repository);
  const { text: repoContext } = await buildRepoContext(
    workdir,
    rt.cfg.contextWindow,
    agentsMdTemplate,
  );
  const fixPrompt = [
    buildFixUserPrompt({ taskTitle: task.title, taskPrompt: task.prompt, review }),
    `\n# Repository context\n${repoContext}`,
  ].join('\n');
  const skillsSection = buildSkillsSection(await loadTaskSkills(task));
  const result = await requestChanges(rt, task, repoContext, fixPrompt, skillsSection);
  await logEvent(task.id, `LLM proposed ${result.changes.length} fix change(s): ${result.summary}`);
  return result;
}

// The fix tail shared by the review loop and the address-review job
// (AGENTS.md §6 — single home): assumes the task branch is already checked
// out in `workdir`; proposes/applies fixes and pushes to the same branch.
export async function applyReviewFixes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  if (config.AGENT_EXECUTOR === 'hermes') {
    await runHermesFixIteration(task, rt, review, headBranch, workdir, secrets, auth);
    return;
  }
  const { summary, changes } = await proposeFixes(task, rt, review, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'no fix changes produced; the branch is unchanged');
    return;
  }
  await commitAndPush(task, rt, workdir, summary, ['push', 'origin', headBranch], secrets, auth);
  await logEvent(task.id, `pushed review fixes to ${headBranch}`);
}

// Clones the repo, checks out the task branch, applies LLM fixes for the
// review issues, commits, and pushes back to the same branch.
async function runReviewFixIteration(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await logEvent(task.id, 'applying review fixes');
  await checkoutTaskBranch(
    workdir,
    cloneUrl,
    task.repository.defaultBranch,
    headBranch,
    secrets,
    auth,
  );
  await applyReviewFixes(task, rt, review, headBranch, workdir, cloneUrl, secrets, auth);
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

// Auto-merge is delegated to the merge-gate job: it waits for green CI,
// sends hermes to fix failing checks, and resolves conflicts (again waiting
// for CI on the resolution). The review job ends here — flip the task back
// to awaiting_review so the landing page no longer shows it as "reviewing".
async function finishReview(task: TaskWithRepo, review: PrReview): Promise<void> {
  await setTaskStatus(task.id, 'awaiting_review');
  if (review.verdict === 'changes_requested') {
    await logEvent(
      task.id,
      `review fix limit reached (${MAX_REVIEW_FIX_ATTEMPTS}); continuing with the latest state`,
    );
  }
  if (!task.repository.autoMergePr) {
    await logEvent(
      task.id,
      review.verdict === 'approve'
        ? 'approved by LLM, awaiting manual merge'
        : 'changes still requested, awaiting manual review',
    );
    return;
  }
  await logEvent(task.id, 'queued the merge gate — auto-merge once CI is green');
  await enqueueMergeGate(task.id, 0, 0);
}

// Shared tail of both executors' review flows (single home — it used to be
// duplicated verbatim between the internal and hermes paths): while the
// reviewer keeps requesting changes and the attempt cap allows it, run one
// fix iteration and queue a re-review; otherwise hand the PR to the merge
// gate / manual review.
async function continueOrFinishReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  attempt: number,
  runFixIteration: () => Promise<void>,
): Promise<void> {
  if (review.verdict === 'changes_requested' && attempt < MAX_REVIEW_FIX_ATTEMPTS) {
    await runFixIteration();
    await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
    await enqueueReviewTask(task.id, attempt + 1);
    await logEvent(task.id, 'queued re-review of the updated pull request');
    return;
  }
  await finishReview(task, review);
}

// Returns the runtime so the caller can persist cumulative token usage.
async function executeReviewTask(
  task: TaskWithRepo,
  headBranch: string,
  attempt: number,
  workdir: string,
  secrets: string[],
): Promise<LlmRuntime> {
  // Signal that the agent is actively reviewing — this shows the task as
  // "reviewing code" on the landing page while the review job runs.
  await setTaskStatus(task.id, 'reviewing_code');
  // The repository's review LLM (when configured) wins over the task's
  // implementation config — review and fix iterations run on it.
  const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
    task.repository.reviewLlmConfigId,
  );
  if (config.AGENT_EXECUTOR === 'hermes') {
    return executeHermesReview(task, rt, headBranch, attempt, workdir, cloneUrl, secrets, gitAuth);
  }
  const diff = await fetchReviewDiff(task, headBranch);
  await logEvent(task.id, `reviewing pull request (attempt ${attempt + 1})`);
  const review = await requestReview(rt, task, diff);
  await logReview(task.id, review, rt.usedTokens);
  await continueOrFinishReview(task, rt, review, attempt, () =>
    runReviewFixIteration(task, rt, review, headBranch, workdir, cloneUrl, secrets, gitAuth),
  );
  return rt;
}

// Hermes review flow: clone + checkout the task branch, let the agent review
// it, let the same agent fix findings on that checkout, then hand the PR to
// the merge gate exactly like the internal path.
async function executeHermesReview(
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
  await logEvent(task.id, `reviewing pull request (attempt ${attempt + 1})`);
  let review = await requestReviewViaHermes(task, rt, workdir, headBranch, secrets);
  if (!review) {
    await logEvent(
      task.id,
      `no valid ${HERMES_REVIEW_FILENAME} from hermes, falling back to a direct LLM review`,
    );
    review = await requestReview(rt, task, await fetchReviewDiff(task, headBranch));
  }
  await logReview(task.id, review, rt.usedTokens);
  await continueOrFinishReview(task, rt, review, attempt, () =>
    runHermesFixIteration(task, rt, review, headBranch, workdir, secrets, auth),
  );
  return rt;
}

export async function reviewTask(taskId: string, attempt = 0): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'review-pr: task not found');
    return;
  }
  // Only review PRs still waiting for review on an opted-in repository.
  // 'reviewing_code' is accepted so re-enqueued review iterations (fix
  // loop) and BullMQ retries don't bounce on the guard.
  const inReview = task.status === 'awaiting_review' || task.status === 'reviewing_code';
  if (!inReview || !task.repository.autoReviewPr) {
    return;
  }
  if (!task.branchName) {
    await logEvent(taskId, 'cannot review: the task has no branch');
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, `review-${taskId}-${attempt}`);
  let rt: LlmRuntime | null = null;
  try {
    rt = await executeReviewTask(task, task.branchName, attempt, workdir, secrets);
  } catch (err) {
    // Record the failure. A rate-limited review defers itself past the
    // provider's quota window and completes the job instead of rethrowing —
    // BullMQ's 60s backoff is useless against a multi-hour 429 and the old
    // path stranded the PR after the bounded recovery budget ran out. Other
    // failures rethrow so BullMQ retries the job with backoff; if the final
    // attempt also fails the PR stays in reviewing_code until
    // pr-state-sync's bounded recovery re-enqueues it.
    await recordJobFailure('review-pr', taskId, err, secrets);
    if (await deferRateLimitedReview(taskId, err)) return;
    throw err;
  } finally {
    await persistTokenUsage(
      taskId,
      rt?.usedTokens ?? task.llmTokensUsed,
      rt ? tokenSplit(rt) : undefined,
    );
    await cleanupWorkdir(workdir, taskId);
  }
}
