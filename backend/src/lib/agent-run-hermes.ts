import { config } from '../config.js';
import { logEvent } from './agent-git.js';
import type { LlmRuntime, TaskWithRepo } from './agent-runtime.js';
import { runHermesTask } from './hermes-runner.js';

// Hermes executor plumbing for the run-task job. Extracted from agent-run.ts.

const HERMES_INSTRUCTIONS =
  'Work in the current directory (a freshly cloned repository). Implement the task completely, including tests if the project has a test setup. Respect the repository’s own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.';

const RESUME_INSTRUCTIONS =
  'RESUMED RUN: a previous attempt was interrupted (redeploy). The current directory already contains the task branch with its uncommitted work — inspect the current state and CONTINUE the implementation from where it stopped; do not start over or redo completed work.';

function hermesPrompt(task: TaskWithRepo, rt: LlmRuntime, resume = false): string {
  return [
    `# Task\n${task.title}`,
    task.prompt ? `\n${task.prompt}` : '',
    ...(rt.cfg.systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', rt.cfg.systemPromptExtra]
      : []),
    ...(resume ? ['', RESUME_INSTRUCTIONS] : []),
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
): Promise<void> {
  await logEvent(task.id, resume ? 'resuming hermes agent' : 'running hermes agent');
  await runHermesTask({
    workdir,
    prompt: hermesPrompt(task, rt, resume),
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
