import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logEvent, hasDirtyWorkdir } from '../agent-git.js';
import { buildSkillsSection } from '../agent-prompts.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { loadTaskSkills } from '../task-skills.js';
import { runLemcoreLoop, loadTranscript, type LemcoreMessage } from './loop.js';

// Shared instructions used by both lemcore and hermes executors
// for the base system section.
export const HERMES_INSTRUCTIONS =
  "Work in the current directory (a freshly cloned repository). Implement the task completely, including tests if the project has a test setup. Respect the repository's own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.";

const RESUME_INSTRUCTIONS =
  'RESUMED RUN: a previous attempt was interrupted (redeploy). The current directory already contains the task branch with its uncommitted work — inspect the current state and CONTINUE the implementation from where it stopped; do not start over or redo completed work.';

function lemcorePrompt(task: TaskWithRepo, rt: LlmRuntime, resume = false): string {
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

/** Write selected skills under .agents/skills/<slug>/SKILL.md (hermes parity). */
export async function materializeTaskSkills(
  task: TaskWithRepo,
  workdir: string,
): Promise<string> {
  const skills = await loadTaskSkills(task);
  if (skills.length === 0) return '';
  for (const skill of skills) {
    const dir = path.join(workdir, '.agents', 'skills', skill.slug);
    await fs.mkdir(dir, { recursive: true });
    const body = `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`;
    await fs.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
  }
  await logEvent(task.id, `active skills: ${skills.map((s) => s.slug).join(', ')}`);
  await logEvent(
    task.id,
    'note: lemcore does not invoke MCP servers; .mcp.json is written for parity only',
  );
  return buildSkillsSection(skills);
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
  /** When set, used as the user prompt instead of the default task prompt. */
  promptOverride?: string;
  existingTranscript?: unknown;
}): Promise<LemcoreTaskResult> {
  const { taskId, task, workdir, rt, secrets, resume, promptOverride } = opts;

  await logEvent(taskId, resume ? 'resuming lemcore agent' : 'running lemcore agent');

  const skillsSection = await materializeTaskSkills(task, workdir);
  const prompt = promptOverride ?? lemcorePrompt(task, rt, resume);

  let resumeTranscript: LemcoreMessage[] | undefined;
  if (resume && !promptOverride) {
    resumeTranscript = loadTranscript(workdir) ?? undefined;
    if (resumeTranscript) {
      await logEvent(taskId, `resumed from transcript (${resumeTranscript.length} messages)`);
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
    skillsSection,
  });

  const changed = await hasDirtyWorkdir(workdir);
  return {
    summary: changed ? finalContent || task.title : null,
    changed,
  };
}
