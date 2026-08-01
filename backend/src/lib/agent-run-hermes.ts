import { config } from '../config.js';
import { logEvent } from './agent-git.js';
import type { LlmRuntime, TaskWithRepo } from './agent-runtime.js';
import { runHermesTask } from './hermes-runner.js';

// Hermes executor plumbing for the run-task job. Extracted from agent-run.ts.

const HERMES_INSTRUCTIONS =
  'Work in the current directory (a freshly cloned repository). Implement the task completely, including tests if the project has a test setup. Respect the repository’s own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.';

const RESUME_INSTRUCTIONS =
  'RESUMED RUN: a previous attempt was interrupted (redeploy). The current directory already contains the task branch with its uncommitted work — inspect the current state and CONTINUE the implementation from where it stopped; do not start over or redo completed work.';

// Appended on the automatic no-changes retry (attempt > 1): the previous
// run ended with a clean worktree, which is only acceptable when the task
// is genuinely already satisfied.
const RETRY_INSTRUCTIONS =
  'IMPORTANT: a previous attempt finished without changing a single file. Reading the code is not enough — you MUST edit/create files to implement the task and verify your changes (run the tests/build). Only if the task is already fully implemented in the repository, state that explicitly and explain why no change is needed.';

function hermesPrompt(
  task: TaskWithRepo,
  rt: LlmRuntime,
  resume = false,
  attempt = 1,
): string {
  return [
    `# Task\n${task.title}`,
    task.prompt ? `\n${task.prompt}` : '',
    ...(rt.cfg.systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', rt.cfg.systemPromptExtra]
      : []),
    ...(resume ? ['', RESUME_INSTRUCTIONS] : []),
    ...(attempt > 1 && !resume ? ['', RETRY_INSTRUCTIONS] : []),
    '',
    HERMES_INSTRUCTIONS,
  ].join('\n');
}

export async function runHermesForTask(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
  resume: boolean,
  attempt = 1,
): Promise<void> {
  await logEvent(
    task.id,
    resume
      ? 'resuming hermes agent'
      : `running hermes agent (attempt ${attempt})`,
  );
  await runHermesTask({
    workdir,
    prompt: hermesPrompt(task, rt, resume, attempt),
    llm: {
      baseUrl: rt.cfg.baseUrl,
      apiKey: rt.apiKey,
      model: rt.cfg.model,
      contextWindow: rt.cfg.contextWindow,
    },
    taskId: task.id,
    secrets,
    timeoutMs: config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000,
    stallTimeoutMs: config.AGENT_HERMES_STALL_TIMEOUT_MINUTES * 60_000,
  });
}
