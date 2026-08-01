import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../agent-git.js';
import { hasMeaningfulChanges } from '../workdir-changes.js';
import { loadTaskSkills } from '../task-skills.js';
import { toLemcoreSkills, buildSkillsPromptSection, type LemcoreSkill } from './skills.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { buildLemcoreImplContext } from './graph-context.js';
import { clearGraphSession } from './graph/session.js';
import { scanRepositoryGraph } from './graph-scan.js';
import { runLemcoreLoop, loadTranscript, scrubLegacyInCloneTranscript, type LemcoreMessage } from './loop.js';
import { resetTodoList } from './todo-store.js';
import { clearCheckpoints } from './edit-checkpoint.js';

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

/**
 * Attach graph-derived context once.
 * Prefer implContext (summary + optional task neighborhood); fall back to the
 * scan-only summary when impl context is empty. Never paste both — impl text
 * already embeds summarizeGraph when a session graph exists.
 */
export function appendGraphContext(
  basePrompt: string,
  scanSummary: string,
  implContext: string,
): string {
  const graphBlock = implContext.trim() || scanSummary.trim();
  return [
    basePrompt.trimEnd(),
    '',
    graphBlock,
    '',
    'Use the codebase graph summary above for navigation. Prefer graph_* tools and selective file reads over dumping large source corpora.',
  ].join('\n');
}

/**
 * Write selected skills under .agents/skills/<slug>/SKILL.md (hermes parity)
 * and return progressive-disclosure prompt section + skill objects (one-line
 * summaries only — the agent calls load_skill(name) to read full instructions
 * on demand, saving context vs. the old full-inline approach).
 */
export async function materializeTaskSkills(
  task: TaskWithRepo,
  workdir: string,
): Promise<{ section: string; skills: LemcoreSkill[] }> {
  const skills = await loadTaskSkills(task);
  if (skills.length === 0) return { section: '', skills: [] };
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
  const lemcoreSkills = toLemcoreSkills(skills);
  return { section: buildSkillsPromptSection(lemcoreSkills), skills: lemcoreSkills };
}

export interface LemcoreTaskResult {
  summary: string | null;
  changed: boolean;
}

/** Scan repo → graph session → compact implementation context for the prompt. */
async function prepareGraphBackedPrompt(
  taskId: string,
  task: TaskWithRepo,
  workdir: string,
  rt: LlmRuntime,
  resume: boolean,
  promptOverride?: string,
): Promise<string> {
  const graphScan = await scanRepositoryGraph(taskId, workdir);
  const implContext = buildLemcoreImplContext(
    workdir,
    `${task.title}\n${task.prompt ?? ''}`,
  );
  if (implContext.usedGraph) {
    await logEvent(
      taskId,
      `implementation context from graph (${implContext.source}): ` +
        `~${implContext.summaryTokens} tokens ` +
        `(~${Math.round(implContext.savedRatio * 100)}% under raw dump estimate)`,
    );
  }
  const basePrompt = promptOverride ?? lemcorePrompt(task, rt, resume);
  return appendGraphContext(basePrompt, graphScan.summaryText, implContext.text);
}

function loadResumeTranscript(
  workdir: string,
  resume: boolean,
  promptOverride?: string,
): LemcoreMessage[] | undefined {
  if (!resume || promptOverride) return undefined;
  return loadTranscript(workdir) ?? undefined;
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

  try {
    return await executeLemcoreTask({
      taskId,
      task,
      workdir,
      rt,
      secrets,
      resume,
      promptOverride,
    });
  } finally {
    // Drop in-memory graph so long-lived workers do not retain multi-MB sessions.
    clearGraphSession(workdir);
    // Clear per-workdir module state (TODO list + edit checkpoints) so a
    // long-lived worker doesn't leak the previous run's state into the next
    // (these are keyed by workdir to survive concurrency, not across runs).
    resetTodoList(workdir);
    clearCheckpoints(workdir);
  }
}

async function executeLemcoreTask(opts: {
  taskId: string;
  task: TaskWithRepo;
  workdir: string;
  rt: LlmRuntime;
  secrets: string[];
  resume: boolean;
  promptOverride?: string;
}): Promise<LemcoreTaskResult> {
  const { taskId, task, workdir, rt, secrets, resume, promptOverride } = opts;

  await logEvent(taskId, resume ? 'resuming lemcore agent' : 'running lemcore agent');
  // Older builds wrote the resume transcript inside the clone; remove any
  // leftover so it cannot land in the task commit / PR.
  scrubLegacyInCloneTranscript(workdir);

  let prompt = await prepareGraphBackedPrompt(
    taskId,
    task,
    workdir,
    rt,
    resume,
    promptOverride,
  );
  // Cross-run learning memory: if a previous run on this repo recorded
  // non-obvious facts (test command, flaky test, build trick) in LEARNED.md,
  // surface them so the agent doesn't rediscover them. The file is written by
  // the agent itself during the run (see loop-constants prompt instruction).
  try {
    const learned = await fs.readFile(path.join(workdir, 'LEARNED.md'), 'utf8');
    if (learned.trim()) {
      prompt = `${prompt}\n\n# Learned from previous runs\n${learned}`;
    }
  } catch { /* no LEARNED.md yet — fine */ }
  const { section: skillsSection, skills: lemcoreSkills } = await materializeTaskSkills(task, workdir);
  const resumeTranscript = loadResumeTranscript(workdir, resume, promptOverride);
  if (resumeTranscript) {
    await logEvent(taskId, `resumed from transcript (${resumeTranscript.length} messages)`);
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
    skills: lemcoreSkills,
  });

  // Attachments/skills and agent scratch must not count as a produced change:
  // a run that only read files must NOT be treated as done.
  const changed = await hasMeaningfulChanges(workdir);
  return {
    summary: changed ? finalContent || task.title : null,
    changed,
  };
}
