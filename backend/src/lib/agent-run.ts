import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  applyChanges,
  cleanupWorkdir,
  cloneRepository,
  git,
  hasDirtyWorkdir,
  logEvent,
  persistTokenUsage,
  recordJobFailure,
  type GitAuth,
} from './agent-git.js';
import { pushTaskBranch, recordChangedPaths } from './agent-publish.js';
import {
  buildPrBody,
  buildSkillsSection,
  generateBranchName,
  requestChanges,
  type LlmChangesResponse,
} from './agent-prompts.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  tokenSplit,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { resolveAgentExecutor } from './agent-executor.js';
import { runHermesForTask } from './agent-run-hermes.js';
import { runLemcoreTask } from './lemcore/run.js';
import { classifyError } from './errors.js';
import { notify, notifyTaskCompleted } from './notifications.js';
import { prisma } from './prisma.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { openPullRequest } from './pull-requests.js';
import { buildRepoContext } from './repo-context.js';
import { buildTaskAttachmentFiles } from './repo-init.js';
import { loadAgentsMdTemplate, loadTaskSkills } from './task-skills.js';
import { setTaskStatus } from './task-events.js';
import { claimTaskForRun, RUN_CLAIMABLE_STATUSES } from './task-claim.js';
import { TaskPausedError } from './task-pause.js';
import {
  NoChangesProducedError,
  handleNoChangesProduced,
  taskStillClaimable,
  type RunOutcome,
} from './agent-run-retry.js';
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

async function logContextManifest(
  taskId: string,
  files: Array<{ path: string; chars: number }>,
  totalChars: number,
): Promise<void> {
  for (const file of files) {
    await logEvent(taskId, `read ${file.path} (${file.chars} chars)`);
  }
  await logEvent(
    taskId,
    `repository context ready: ${files.length} key file(s), ${totalChars} chars`,
  );
}

// Resolves the task's skills to a system-prompt section; logs which skills
// are active so the run console shows what was injected.
async function taskSkillsSection(task: TaskWithRepo): Promise<string> {
  const skills = await loadTaskSkills(task);
  if (skills.length === 0) return '';
  await logEvent(task.id, `active skills: ${skills.map((s) => s.slug).join(', ')}`);
  return buildSkillsSection(skills);
}

async function proposeTaskChanges(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
): Promise<LlmChangesResponse> {
  await logEvent(task.id, 'building repository context');
  const agentsMdTemplate = await loadAgentsMdTemplate(task.repository);
  const { text: repoContext, files } = await buildRepoContext(
    workdir,
    rt.cfg.contextWindow,
    agentsMdTemplate,
  );
  await logContextManifest(task.id, files, repoContext.length);
  const skillsSection = await taskSkillsSection(task);
  const result = await requestChanges(rt, task, repoContext, undefined, skillsSection);
  await logEvent(task.id, `LLM proposed ${result.changes.length} change(s): ${result.summary}`);
  await logEvent(task.id, `LLM usage so far: ~${rt.usedTokens} tokens`);
  return result;
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

// Runs the configured task executor. Returns the change summary for the
// commit/PR, or null when the workdir has nothing to commit.
// Executor comes from Settings → Agent (per-user override) via
// resolveAgentExecutor — never the bare AGENT_EXECUTOR env alone, or a
// user who picked lemcore would still get hermes when the deployment
// default is hermes.
async function implementTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
  resume: boolean,
  attempt: number,
): Promise<string | null> {
  const userId = task.repository.connection.userId;
  const executor = await resolveAgentExecutor(userId);
  await logEvent(task.id, `executor: ${executor}`);
  if (executor === 'hermes') {
    await runHermesForTask(task, rt, workdir, secrets, resume, attempt);
    return (await hasDirtyWorkdir(workdir)) ? task.title : null;
  }
  if (executor === 'lemcore') {
    const result = await runLemcoreTask({
      taskId: task.id,
      task,
      workdir,
      rt,
      secrets,
      resume,
    });
    return result.changed ? task.title : null;
  }
  const { summary, changes } = await proposeTaskChanges(task, rt, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  await logEvent(task.id, `applied ${applied} of ${changes.length} proposed change(s)`);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) return null;
  return summary;
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

// Returns the runtime so the caller can persist cumulative token usage.
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
  await pushTaskBranch(task, rt, workdir, branchName, summary, secrets, gitAuth);
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
    // enqueues one immediate retry with a stronger prompt; the loop below
    // picks that delivery up. 'retry' skips the completion hook — the task
    // is not finished yet.
    for (let attempt = 1; ; attempt++) {
      const result = await executeRunTask(task, workdir, secrets, attempt);
      rt = result.rt;
      if (result.outcome === 'final') break;
      if (!(await taskStillClaimable(taskId, RUN_CLAIMABLE_STATUSES))) {
        logger.info(
          { taskId },
          'run-task: retry requeue lost (cancelled or claimed), standing down',
        );
        return;
      }
      if (!(await claimTaskForRun(taskId))) return;
      // Refresh so the next attempt sees the current prompt/branch/prUrl.
      const fresh = await loadTaskWithRepo(taskId);
      if (fresh) task = fresh;
    }
    // Terminal 'done' runs (no auto-PR, empty repo) notify here; the
    // auto-PR path ends awaiting_review and already fired pr_opened. A
    // dispatch failure must not fail the run, but it is logged — silent
    // notification loss is exactly what this subsystem exists to prevent.
    await notifyTaskCompleted(taskId).catch((err: unknown) => {
      logger.error({ taskId, err }, 'run-task: task_completed notification failed');
    });
  } catch (err) {
    if (err instanceof TaskPausedError) {
      // Status is already 'paused' (set by the pause route); the saved
      // transcript + kept workdir let resume replay the run. Not a failure.
      await logEvent(taskId, 'paused by user — resume continues from the saved transcript').catch(() => {});
      return;
    }
    if (err instanceof NoChangesProducedError) {
      // Status/errorCode were already set when the last attempt gave up; log
      // the failure without clobbering them via the generic classifier.
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
    // The workdir outlives the run only while the PR awaits review/merge or
    // the task is paused (resume replays the transcript from it); it is
    // removed once the task is done (merged), failed, or cancelled.
    const status = (await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } }))
      ?.status;
    if (status === 'awaiting_review' || status === 'reviewing_code') {
      await logEvent(taskId, 'workdir kept until the pull request is merged').catch(() => {});
    } else if (status !== 'paused') {
      await cleanupWorkdir(workdir, taskId);
    }
  }
}
