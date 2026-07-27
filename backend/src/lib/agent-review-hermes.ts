import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  commitAndPush,
  hasDirtyWorkdir,
  logEvent,
  type GitAuth,
} from './agent-git.js';
import type { LlmRuntime, TaskWithRepo } from './agent-runtime.js';
import { runHermesTask } from './hermes-runner.js';
import {
  buildHermesFixPrompt,
  buildHermesReviewPrompt,
  HERMES_REVIEW_FILENAME,
  parsePrReview,
  type PrReview,
} from './pr-review.js';

// Hermes executor: the same agent that implements the task also reviews the
// PR and applies the fixes, so implementation → review → merge runs on one
// executor end to end. Extracted from agent-review.ts.

function hermesLlm(rt: LlmRuntime) {
  return {
    baseUrl: rt.cfg.baseUrl,
    apiKey: rt.apiKey,
    model: rt.cfg.model,
    contextWindow: rt.cfg.contextWindow,
  };
}

// Reads and ALWAYS deletes the verdict file — left behind, it would dirty
// the workdir and ride along into the fix commit.
async function readHermesReviewFile(workdir: string): Promise<PrReview | null> {
  const file = path.join(workdir, HERMES_REVIEW_FILENAME);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  await fs.rm(file, { force: true });
  if (!text) return null;
  try {
    return parsePrReview(text);
  } catch {
    return null;
  }
}

// Hermes reviews the checked-out branch itself (it runs git diff/read); the
// verdict comes back as a JSON file. Null means no usable verdict — the
// caller falls back to a direct LLM review of the provider diff.
export async function requestReviewViaHermes(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  headBranch: string,
  secrets: string[],
): Promise<PrReview | null> {
  await logEvent(task.id, 'reviewing pull request with the hermes agent');
  await runHermesTask({
    workdir,
    prompt: buildHermesReviewPrompt({
      taskTitle: task.title,
      taskPrompt: task.prompt,
      baseBranch: task.repository.defaultBranch,
      headBranch,
      systemPromptExtra: rt.cfg.systemPromptExtra,
    }),
    llm: hermesLlm(rt),
    taskId: task.id,
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
  });
  return readHermesReviewFile(workdir);
}

// Fix iteration on the SAME checkout the review ran in: hermes edits the
// task branch, git commit/push stays external.
export async function runHermesFixIteration(
  task: TaskWithRepo,
  rt: LlmRuntime,
  review: PrReview,
  headBranch: string,
  workdir: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await logEvent(task.id, 'applying review fixes with the hermes agent');
  await runHermesTask({
    workdir,
    prompt: buildHermesFixPrompt({
      taskTitle: task.title,
      taskPrompt: task.prompt,
      review,
      systemPromptExtra: rt.cfg.systemPromptExtra,
    }),
    llm: hermesLlm(rt),
    taskId: task.id,
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
  });
  if (!(await hasDirtyWorkdir(workdir))) {
    await logEvent(task.id, 'no fix changes produced; re-reviewing the existing branch');
    return;
  }
  await commitAndPush(
    task,
    rt,
    workdir,
    'address review issues',
    ['push', 'origin', headBranch],
    secrets,
    auth,
  );
  await logEvent(task.id, `pushed review fixes to ${headBranch}`);
}
