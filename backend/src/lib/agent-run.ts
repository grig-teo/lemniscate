import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  cleanupWorkdir,
  cloneRepository,
  commitAndPush,
  git,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  type GitAuth,
} from './agent-git.js';
import { buildPrBody, generateBranchName } from './agent-prompts.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { implementTask } from './agent-run-implement.js';
import {
  NoChangesProducedError,
  handleNoChangesProduced,
  runWithNoChangeRetries,
  type RunOutcome,
} from './agent-run-retry.js';
import { classifyError } from './errors.js';
import { notify, notifyTaskCompleted } from './notifications.js';
import { prisma } from './prisma.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { openPullRequest } from './pull-requests.js';
import { buildTaskAttachmentFiles } from './repo-init.js';
import { setTaskStatus } from './task-events.js';
import { claimTaskForRun, RUN_CLAIMABLE_STATUSES } from './task-claim.js';
import { errorMessage } from './utils.js';

// Job: run-task — clone → LLM-proposed changes → branch → commit → push →
// pull request. Extracted from agent-loop.ts.

async function cloneForTask(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
): Promise<boolean> {
  const { repository } = task;
  await logEvent(task.id, `cloning ${repository.fullName} (${repository.defaultBranch})`);
  const { emptyRepo } = await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets, {
    taskId: task.id,
    auth,
  });
  return emptyRepo;
}

// An empty repository has no base for a task branch or PR: work directly on
// the default branch and finish after the push.
async function prepareEmptyRepoBranch(task: TaskWithRepo): Promise<string> {
  const branchName = task.repository.defaultBranch;
  await logEvent(task.id, `bootstrapping empty repository on ${branchName}`);
  await prisma.task.update({ where: { id: task.id }, data: { branchName } });
  return branchName;
}

// Library attachments selected for this run (.mcp.json, per-folder
// AGENTS.md) are written into the workdir before the agent starts, so they
// become part of the task's own commit.
async function writeTaskAttachments(task: TaskWithRepo, workdir: string): Promise<void> {
  const files = buildTaskAttachmentFiles(task);
  for (const file of files) {
    const target = path.join(workdir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
    await logEvent(task.id, `attached ${file.path}`);
  }
}

async function createTaskBranch(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
): Promise<string> {
  const branchName = await generateBranchName(rt, task);
  await git(['checkout', '-b', branchName], { cwd: workdir, taskId: task.id });
  await prisma.task.update({ where: { id: task.id }, data: { branchName } });
  await logEvent(task.id, `created branch ${branchName}`);
  return branchName;
}

async function pushBranch(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  branchName: string,
  summary: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await commitAndPush(
    task,
    rt,
    workdir,
    summary,
    ['push', '-u', 'origin', branchName],
    secrets,
    auth,
  );
  await logEvent(task.id, `pushed branch ${branchName}`);
}

async function openTaskPullRequest(
  task: TaskWithRepo,
  rt: LlmRuntime,
  branchName: string,
  summary: string,
): Promise<void> {
  const { repository } = task;
  await logEvent(task.id, `opening pull request (${branchName} → ${repository.defaultBranch})`);
  const { prUrl } = await openPullRequest(repository.connection, {
    repoFullName: repository.fullName,
    headBranch: branchName,
    baseBranch: repository.defaultBranch,
    title: task.title,
    body: buildPrBody(task, summary),
  });
  await prisma.task.update({ where: { id: task.id }, data: { prUrl } });
  await setTaskStatus(task.id, 'awaiting_review');
  await logEvent(task.id, `opened pull request: ${prUrl}`);
  await notify(repository.connection.userId, 'pr_opened', {
    title: `PR opened: ${task.title}`,
    body: `${repository.fullName} — pull request is awaiting review`,
    taskId: task.id,
    prUrl,
  });
  await persistTokenUsage(task.id, rt.usedTokens, tokenSplit(rt));
  if (repository.autoReviewPr) {
    await enqueueReviewTask(task.id);
    await logEvent(task.id, 'queued LLM review of the pull request');
  }
}

async function finalizeRunTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  branchName: string,
  summary: string,
): Promise<void> {
  if (!task.repository.autoCreatePr) {
    await setTaskStatus(task.id, 'done');
    return;
  }
  await openTaskPullRequest(task, rt, branchName, summary);
}

// Persists the repo-relative paths the task branch changed (feeds the
// run-targets endpoint). Fail-soft: a failed diff is logged to the task
// console and changedPaths stays null, so the endpoint falls back to the
// repository platform.
async function recordChangedPaths(task: TaskWithRepo, workdir: string): Promise<void> {
  try {
    const out = await git(
      ['diff', '--name-only', `${task.repository.defaultBranch}...HEAD`],
      { cwd: workdir, taskId: task.id },
    );
    const changedPaths = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    await prisma.task.update({ where: { id: task.id }, data: { changedPaths } });
  } catch (err) {
    await logEvent(task.id, `could not record changed paths: ${(err as Error).message}`).catch(
      () => {},
    );
  }
}

// A run interrupted mid-implementation (a redeploy killed the worker) leaves
// its clone on the persistent workdir volume; the saved task branch plus that
// workdir let the next attempt continue instead of starting over.
export async function resumableWorkdir(task: TaskWithRepo, workdir: string): Promise<boolean> {
  if (!task.branchName) return false;
  const stat = await fs.stat(path.join(workdir, '.git')).catch(() => null);
  return stat?.isDirectory() ?? false;
}

// Fresh attempt: drop any stale leftovers from a crashed earlier attempt,
// clone, and create (or bootstrap) the task branch.
async function prepareFreshRun(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
  auth: GitAuth,
  rt: LlmRuntime,
): Promise<{ branchName: string; emptyRepo: boolean }> {
  await cleanupWorkdir(workdir);
  const emptyRepo = await cloneForTask(task, workdir, cloneUrl, secrets, auth);
  const branchName = emptyRepo
    ? await prepareEmptyRepoBranch(task)
    : await createTaskBranch(task, rt, workdir);
  return { branchName, emptyRepo };
}

// Runs one full pass (clone/resume → implement → push → PR). Returns the
// runtime (so the caller can persist cumulative token usage) plus the
// outcome — 'retry' means the run produced no changes and requeued itself
// for another attempt, so the caller must NOT fire completion hooks.
async function executeRunTask(
  task: TaskWithRepo,
  workdir: string,
  secrets: string[],
  attempt: number,
): Promise<{ rt: LlmRuntime; outcome: RunOutcome }> {
  await logEvent(task.id, 'checking repository push access');
  const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
  );
  await setTaskStatus(task.id, 'running');
  const resume = await resumableWorkdir(task, workdir);
  await logEvent(
    task.id,
    resume
      ? `resuming task "${task.title}" on ${task.repository.fullName} from the saved workdir (${task.branchName})`
      : `starting task "${task.title}" on ${task.repository.fullName}`,
  );
  // Empty-repo tasks work on the default branch (no task branch, no PR) —
  // on a resume that is exactly the branchName === defaultBranch case.
  const { branchName, emptyRepo } = resume
    ? {
        branchName: task.branchName as string,
        emptyRepo: task.branchName === task.repository.defaultBranch,
      }
    : await prepareFreshRun(task, workdir, cloneUrl, secrets, gitAuth, rt);
  await writeTaskAttachments(task, workdir);
  const summary = await implementTask(task, rt, workdir, secrets, resume, attempt);
  if (summary === null) {
    if (task.prUrl) {
      // A duplicate/resumed run found nothing new, but a PR is already open
      // — the pipeline continues through review/merge. 'done' is only for
      // merged work (or no-PR flows), never while a PR is still open.
      await logEvent(
        task.id,
        'no changes produced; the existing pull request continues through review',
      );
      await setTaskStatus(task.id, 'awaiting_review');
      return { rt, outcome: 'final' };
    }
    // The agent left the worktree clean and there is no PR — nothing was
    // implemented. Never mark that 'done': retry while attempts remain,
    // otherwise fail the task (throws NoChangesProducedError).
    const outcome = await handleNoChangesProduced(task.id, attempt);
    return { rt, outcome };
  }
  await pushBranch(task, rt, workdir, branchName, summary, secrets, gitAuth);
  await recordChangedPaths(task, workdir);
  if (emptyRepo) {
    await logEvent(task.id, `empty repository bootstrapped on ${branchName}; no PR opened`);
    await setTaskStatus(task.id, 'done');
    return { rt, outcome: 'final' };
  }
  await finalizeRunTask(task, rt, branchName, summary);
  return { rt, outcome: 'final' };
}

export async function runTask(taskId: string): Promise<void> {
  let task = await loadTaskWithRepo(taskId);
  if (!task) {
    logger.error({ taskId }, 'run-task: task not found');
    return;
  }
  // Nothing to do for terminal tasks (covers 'cancelled' defensively too).
  if (task.status === 'failed' || (task.status as string) === 'cancelled') {
    return;
  }
  // Exactly-once claim: a duplicate delivery (double-enqueue past jobId
  // dedupe, or a BullMQ stalled re-delivery while the original still runs)
  // loses the atomic flip to 'running' and stands down here, before it can
  // clobber the shared workdir or open a duplicate PR.
  if (!(await claimTaskForRun(taskId))) {
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, taskId);
  let rt: LlmRuntime | null = null;
  try {
    // A run that produced no changes requeues itself (status 'queued') and
    // enqueues one immediate retry with a stronger prompt; the loop picks
    // that delivery up and stands down when the requeue was lost (cancelled
    // or claimed by a duplicate executor). 'retry' skips the completion
    // hook — the task is not finished yet.
    const result = await runWithNoChangeRetries(taskId, task, RUN_CLAIMABLE_STATUSES, (t, attempt) =>
      executeRunTask(t, workdir, secrets, attempt),
    );
    rt = result.rt;
    if (result.stoodDown) return;
    // Terminal 'done' runs (no auto-PR, empty repo) notify here;
    // the auto-PR path ends awaiting_review and already fired pr_opened.
    // A dispatch failure must not fail the run, but it is logged — silent
    // notification loss is exactly what this subsystem exists to prevent.
    await notifyTaskCompleted(taskId).catch((err: unknown) => {
      logger.error({ taskId, err }, 'run-task: task_completed notification failed');
    });
  } catch (err) {
    if (err instanceof NoChangesProducedError) {
      // Status/errorCode were already set when the last attempt gave up;
      // log the failure without clobbering them via the generic classifier.
      await recordJobFailure('run-task', taskId, err, secrets).catch(() => {});
      return;
    }
    // Failure state is fully recorded on the task; the BullMQ job is allowed
    // to complete so it is not retried into a duplicate branch/PR.
    const message = await recordJobFailure('run-task', taskId, err, secrets);
    const errorCode = classifyError(err);
    await setTaskStatus(taskId, 'failed', { error: message, errorCode }).catch(() => {});
  } finally {
    await persistTokenUsage(
      taskId,
      rt?.usedTokens ?? task.llmTokensUsed,
      rt ? tokenSplit(rt) : undefined,
    );
    // The workdir outlives the run only while the PR awaits review/merge —
    // it is removed once the task is done (merged), failed, or cancelled.
    if (await isAwaitingReview(taskId)) {
      await logEvent(taskId, 'workdir kept until the pull request is merged').catch(() => {});
    } else {
      await cleanupWorkdir(workdir, taskId);
    }
  }
}

async function isAwaitingReview(taskId: string): Promise<boolean> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
  return task?.status === 'awaiting_review' || task?.status === 'reviewing_code';
}
