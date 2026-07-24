import path from 'node:path';
import fs from 'node:fs/promises';
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
  buildSkillsSection,
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
import { runHermesTask } from './hermes-runner.js';
import { prisma } from './prisma.js';
import { enqueueReviewTask } from './proposal-scheduler.js';
import { openPullRequest } from './pull-requests.js';
import { buildRepoContext } from './repo-context.js';
import { buildTaskAttachmentFiles } from './repo-init.js';
import { loadAgentsMdTemplate, loadTaskSkills } from './task-skills.js';
import { setTaskStatus } from './task-events.js';

// Job: run-task — clone → LLM-proposed changes → branch → commit → push →
// pull request. Extracted from agent-loop.ts.

async function cloneForTask(
  task: TaskWithRepo,
  workdir: string,
  cloneUrl: string,
  secrets: string[],
): Promise<boolean> {
  const { repository } = task;
  await logEvent(task.id, `cloning ${repository.fullName} (${repository.defaultBranch})`);
  const { emptyRepo } = await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets, {
    taskId: task.id,
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

const HERMES_INSTRUCTIONS =
  'Work in the current directory (a freshly cloned repository). Implement the task completely, including tests if the project has a test setup. Do NOT git commit, push, or create branches — git is handled externally.';

function hermesPrompt(task: TaskWithRepo, rt: LlmRuntime): string {
  return [
    `# Task\n${task.title}`,
    task.prompt ? `\n${task.prompt}` : '',
    ...(rt.cfg.systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', rt.cfg.systemPromptExtra]
      : []),
    '',
    HERMES_INSTRUCTIONS,
  ].join('\n');
}

async function runHermesForTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<void> {
  await logEvent(task.id, 'running hermes agent');
  await runHermesTask({
    workdir,
    prompt: hermesPrompt(task, rt),
    llm: {
      baseUrl: rt.cfg.baseUrl,
      apiKey: rt.apiKey,
      model: rt.cfg.model,
      contextWindow: rt.cfg.contextWindow,
    },
    taskId: task.id,
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
  });
}

// Runs the configured task executor. Returns the change summary for the
// commit/PR, or null when the workdir has nothing to commit.
async function implementTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<string | null> {
  if (config.AGENT_EXECUTOR === 'hermes') {
    await runHermesForTask(task, rt, workdir, secrets);
    return (await hasDirtyWorkdir(workdir)) ? task.title : null;
  }
  const { summary, changes } = await proposeTaskChanges(task, rt, workdir);
  const applied = await applyChanges(task.id, workdir, changes, secrets);
  await logEvent(task.id, `applied ${applied} of ${changes.length} proposed change(s)`);
  if (applied === 0 || !(await hasDirtyWorkdir(workdir))) return null;
  return summary;
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
  const emptyRepo = await cloneForTask(task, workdir, cloneUrl, secrets);
  const branchName = emptyRepo
    ? await prepareEmptyRepoBranch(task)
    : await createTaskBranch(task, rt, workdir);
  await writeTaskAttachments(task, workdir);
  const summary = await implementTask(task, rt, workdir, secrets);
  if (summary === null) {
    await logEvent(task.id, 'no changes produced; nothing to commit');
    await setTaskStatus(task.id, 'done');
    return rt;
  }
  await pushBranch(task, rt, workdir, branchName, summary, secrets);
  if (emptyRepo) {
    await logEvent(task.id, `empty repository bootstrapped on ${branchName}; no PR opened`);
    await setTaskStatus(task.id, 'done');
    return rt;
  }
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
