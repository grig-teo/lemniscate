import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Task } from '@prisma/client';
import { config } from '../config.js';
import {
  applyChanges,
  cleanupWorkdir,
  cloneRepository,
  commitAndPush,
  git,
  hasDirtyWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  sanitizeRelativePath,
} from './agent-git.js';
import { buildSkillsSection, requestChanges, type LlmChangesResponse } from './agent-prompts.js';
import {
  llmCall,
  loadTaskWithRepo,
  prepareAgentRuntime,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { getPullRequestDiff, mergePullRequest } from './pull-requests.js';
import {
  buildConflictResolutionMessages,
  buildFixUserPrompt,
  buildReviewMessages,
  parsePrReview,
  parseResolvedFile,
  type PrReview,
} from './pr-review.js';
import { buildRepoContext } from './repo-context.js';
import { publishTaskEvent, setTaskStatus } from './task-events.js';
import { loadAgentsMdTemplate, loadTaskSkills } from './task-skills.js';

// Job: review-pr — LLM review → fix iterations → optional auto-merge with
// conflict resolution. Extracted from agent-loop.ts.

const MAX_REVIEW_FIX_ATTEMPTS = 3;
const MAX_CONFLICT_RESOLUTIONS = 2;
const MAX_REVIEW_DIFF_CHARS = 24_000;
const MAX_CONFLICT_FILE_CHARS = 40_000;

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

async function checkoutTaskBranch(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  headBranch: string,
  secrets: string[],
): Promise<void> {
  await cloneRepository(workdir, cloneUrl, task.repository.defaultBranch, secrets);
  await git(['fetch', '--depth', '1', 'origin', headBranch], { cwd: workdir, secrets });
  await git(['checkout', '-b', headBranch, 'FETCH_HEAD'], { cwd: workdir });
}

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
): Promise<void> {
  await logEvent(task.id, 'applying review fixes');
  await checkoutTaskBranch(task, workdir, cloneUrl, headBranch, secrets);
  const { summary, changes } = await proposeFixes(task, rt, review, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'no fix changes produced; re-reviewing the existing branch');
    return;
  }
  await commitAndPush(task, rt, workdir, summary, ['push', 'origin', headBranch], secrets);
  await logEvent(task.id, `pushed review fixes to ${headBranch}`);
}

// ---------------------------------------------------------------------------
// Merge with LLM conflict resolution
// ---------------------------------------------------------------------------

// Merges FETCH_HEAD locally; returns the conflicted paths ([] on clean merge).
async function mergeHeadBranch(workdir: string): Promise<string[]> {
  try {
    await git(['merge', '--no-edit', 'FETCH_HEAD'], { cwd: workdir });
    return [];
  } catch {
    const output = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: workdir });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }
}

async function resolveConflictedFile(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  relPath: string,
): Promise<void> {
  const rel = sanitizeRelativePath(relPath);
  const abs = path.join(workdir, rel);
  const conflictedContent = await fs.readFile(abs, 'utf8');
  if (conflictedContent.length > MAX_CONFLICT_FILE_CHARS) {
    throw new Error(`conflicted file ${rel} is too large for LLM resolution`);
  }
  const resolved = parseResolvedFile(
    await llmCall(
      rt,
      buildConflictResolutionMessages({
        path: rel,
        conflictedContent,
        baseBranch: task.repository.defaultBranch,
        headBranch,
        systemPromptExtra: rt.cfg.systemPromptExtra,
      }),
    ),
  );
  await fs.writeFile(abs, resolved, 'utf8');
  await git(['add', '--', rel], { cwd: workdir });
  await publishTaskEvent(task.id, 'diff', { path: rel, action: 'conflict-resolved' });
  await logEvent(task.id, `resolved conflict in ${rel}`);
}

// One conflict-resolution round: merge the head branch into a local checkout
// of the base branch, let the LLM rewrite each conflicted file, commit, and
// push the merge commit to the PR head branch (a fast-forward there, since
// the old head is the merge commit's second parent).
async function resolveMergeConflictsOnce(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
): Promise<void> {
  // Full clone: a shallow one lacks the common ancestor a real merge needs.
  await cloneRepository(workdir, cloneUrl, task.repository.defaultBranch, secrets, {
    shallow: false,
  });
  await git(['fetch', 'origin', headBranch], { cwd: workdir, secrets });
  const conflicted = await mergeHeadBranch(workdir);
  for (const rel of conflicted) {
    await resolveConflictedFile(task, rt, headBranch, workdir, rel);
  }
  if (conflicted.length > 0) {
    await git(['commit', '-m', 'resolve merge conflicts'], { cwd: workdir });
  } else {
    await logEvent(task.id, 'merge applied cleanly locally; publishing the merge');
  }
  await git(['push', 'origin', `HEAD:${headBranch}`], { cwd: workdir, secrets });
}

// Tries to merge the PR; on conflict, hands resolution to the LLM and retries
// (bounded by MAX_CONFLICT_RESOLUTIONS). Status stays 'awaiting_review' when
// the merge ultimately cannot be completed.
async function mergeWithConflictResolution(
  task: TaskWithRepo,
  rt: LlmRuntime,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
): Promise<void> {
  for (let conflictAttempt = 0; ; conflictAttempt += 1) {
    const result = await mergePullRequest(task.repository.connection, {
      repoFullName: task.repository.fullName,
      headBranch,
      baseBranch: task.repository.defaultBranch,
    });
    if (result.merged) {
      await logEvent(task.id, `merged pull request: ${result.prUrl}`);
      await setTaskStatus(task.id, 'done');
      return;
    }
    if (!result.conflict || conflictAttempt >= MAX_CONFLICT_RESOLUTIONS) {
      await logEvent(task.id, 'conflict resolution failed, manual review needed');
      return;
    }
    await logEvent(
      task.id,
      `merge conflict — resolving with the LLM (attempt ${conflictAttempt + 1}/${MAX_CONFLICT_RESOLUTIONS})`,
    );
    await resolveMergeConflictsOnce(task, rt, headBranch, workdir, cloneUrl, secrets);
    await logEvent(task.id, 'pushed conflict resolution; retrying merge');
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

async function finishReview(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
): Promise<void> {
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
  await mergeWithConflictResolution(task, rt, headBranch, workdir, cloneUrl, secrets);
}

// Returns the runtime so the caller can persist cumulative token usage.
async function executeReviewTask(
  task: TaskWithRepo,
  headBranch: string,
  attempt: number,
  workdir: string,
  secrets: string[],
): Promise<LlmRuntime> {
  const { cloneUrl, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
  );
  const diff = await fetchReviewDiff(task, headBranch);
  await logEvent(task.id, `reviewing pull request (attempt ${attempt + 1})`);
  const review = await requestReview(rt, task, diff);
  await logReview(task.id, review, rt.usedTokens);
  if (review.verdict === 'changes_requested' && attempt < MAX_REVIEW_FIX_ATTEMPTS) {
    await runReviewFixIteration(task, rt, review, headBranch, workdir, cloneUrl, secrets);
    await persistTokenUsage(task.id, rt.usedTokens);
    await enqueueReviewTask(task.id, attempt + 1);
    await logEvent(task.id, 'queued re-review of the updated pull request');
    return rt;
  }
  await finishReview(task, rt, review, headBranch, workdir, cloneUrl, secrets);
  return rt;
}

export async function reviewTask(taskId: string, attempt = 0): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    console.error(`review-pr: task ${taskId} not found`);
    return;
  }
  // Only review PRs still waiting for review on an opted-in repository.
  if (task.status !== 'awaiting_review' || !task.repository.autoReviewPr) {
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
    // The PR stays awaiting_review for a human; the review job is not retried.
    await recordJobFailure('review-pr', taskId, err, secrets);
  } finally {
    await persistTokenUsage(taskId, rt?.usedTokens ?? task.llmTokensUsed);
    await cleanupWorkdir(workdir);
  }
}
