import { logEvent } from '../agent-git.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { runLemcoreLoop, type LemcoreMessage } from './loop.js';

// Shared instructions used by both lemcore and hermes executors
// for the base system section.
export const HERMES_INSTRUCTIONS =
  'Work in the current directory (a freshly cloned repository). Implement the task completely, including tests if the project has a test setup. Respect the repository\'s own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.';

const RESUME_INSTRUCTIONS =
  'RESUMED RUN: a previous attempt was interrupted (redeploy). The current directory already contains the task branch with its uncommitted work — inspect the current state and CONTINUE the implementation from where it stopped; do not start over or redo completed work.';

function lemcorePrompt(task: TaskWithRepo, rt: LlmRuntime, resume = false): string {
  // Note: resume is respected for transcript loading but the prompt
  // itself is the same — lemcore picks up from the transcript messages.
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

export interface LemcoreTaskResult {
  summary: string | null;
  changed: boolean;
}

export async function runLemcoreTask(opts: {
  taskId: string;
  task: TaskWithRepo;
  workdir: string;
  rt: LlmRuntime;
  secrets: string[];
  resume: boolean;
  existingTranscript?: unknown;
}): Promise<LemcoreTaskResult> {
  const { taskId, task, workdir, rt, secrets, resume } = opts;

  await logEvent(taskId, resume ? 'resuming lemcore agent' : 'running lemcore agent');

  const prompt = lemcorePrompt(task, rt, resume);

  let resumeTranscript: LemcoreMessage[] | undefined;
  if (resume) {
    try {
      const mod = await import('./loop.js');
      resumeTranscript = mod.loadTranscript(workdir) ?? undefined;
    } catch {
      // Transcript not found or unreadable — start fresh
    }
  }

  const finalContent = await runLemcoreLoop({
    taskId,
    task,
    workdir,
    rt,
    prompt,
    secrets,
    resumeTranscript,
  });

  // Check for .lemniscate-review.json (hermes-compatible verdict file)
  const mod2 = await import('./loop.js');
  const hasReview = await mod2.checkReviewFile(workdir);

  return {
    summary: hasReview ? finalContent : null,
    changed: !hasReview,
  };
}
