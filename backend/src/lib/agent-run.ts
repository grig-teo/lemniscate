import path from 'node:path';
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
} from './agent-git.js';
import {
  buildPrBody,
  generateBranchName,
  requestChanges,
  type LlmChangesResponse,
} from './agent-prompts.js';
import {
  loadTaskWithRepo,
  prepareAgentRuntime,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { prisma } from './prisma.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { openPullRequest } from './pull-requests.js';
import { buildRepoContext } from './repo-context.js';
import { setTaskStatus } from './task-events.js';

// Job: run-task — clone → LLM-proposed changes → branch → commit → push →
// pull request. Extracted from agent-loop.ts.

async function cloneForTask(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
): Promise<void> {
  const { repository } = task;
  await logEvent(task.id, `cloning ${repository.fullName} (${repository.defaultBranch})`);
  await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets, {
    taskId: task.id,
  });
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

async function proposeTaskChanges(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
): Promise<LlmChangesResponse> {
  await logEvent(task.id, 'building repository context');
  const { text: repoContext, files } = await buildRepoContext(workdir, rt.cfg.contextWindow);
  await logContextManifest(task.id, files, repoContext.length);
  const result = await requestChanges(rt, task, repoContext);
  await logEvent(task.id, `LLM proposed ${result.changes.length} change(s): ${result.summary}`);
  await logEvent(task.id, `LLM usage so far: ~${rt.usedTokens} tokens`);
  return result;
}

async function pushBranch(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  branchName: string,
  summary: string,
  secrets: string[],
): Promise<void> {
  await commitAndPush(task, rt, workdir, summary, ['push', '-u', 'origin', branchName], secrets);
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
  await persistTokenUsage(task.id, rt.usedTokens);
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

// Returns the runtime so the caller can persist cumulative token usage.
async function executeRunTask(
  task: TaskWithRepo,
  workdir: string,
  secrets: string[],
): Promise<LlmRuntime> {
  await logEvent(task.id, 'checking repository push access');
  const { cloneUrl, rt } = await prepareAgentRuntime(
    task,
    task.repository,
    secrets,
    task.llmTokensUsed,
  );
  await setTaskStatus(task.id, 'running');
  await logEvent(task.id, `starting task "${task.title}" on ${task.repository.fullName}`);
  await cloneForTask(task, workdir, cloneUrl, secrets);
  const branchName = await createTaskBranch(task, rt, workdir);
  const { summary, changes } = await proposeTaskChanges(task, rt, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  await logEvent(task.id, `applied ${applied} of ${changes.length} proposed change(s)`);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'no changes produced; nothing to commit');
    await setTaskStatus(task.id, 'done');
    return rt;
  }
  await pushBranch(task, rt, workdir, branchName, summary, secrets);
  await finalizeRunTask(task, rt, branchName, summary);
  return rt;
}

export async function runTask(taskId: string): Promise<void> {
  const task = await loadTaskWithRepo(taskId);
  if (!task) {
    console.error(`run-task: task ${taskId} not found`);
    return;
  }
  // Nothing to do for terminal tasks (covers 'cancelled' defensively too).
  if (task.status === 'failed' || (task.status as string) === 'cancelled') {
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, taskId);
  let rt: LlmRuntime | null = null;
  try {
    rt = await executeRunTask(task, workdir, secrets);
  } catch (err) {
    // Failure state is fully recorded on the task; the BullMQ job is allowed
    // to complete so it is not retried into a duplicate branch/PR.
    const message = await recordJobFailure('run-task', taskId, err, secrets);
    await setTaskStatus(taskId, 'failed', { error: message }).catch(() => {});
  } finally {
    await persistTokenUsage(taskId, rt?.usedTokens ?? task.llmTokensUsed);
    await cleanupWorkdir(workdir, taskId);
  }
}
