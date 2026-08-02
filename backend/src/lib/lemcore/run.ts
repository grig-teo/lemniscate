import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../agent-git.js';
import { hasMeaningfulChanges } from '../workdir-changes.js';
import { loadTaskSkills, loadAgentsMdTemplate } from '../task-skills.js';
import { toLemcoreSkills, buildSkillsPromptSection, type LemcoreSkill } from './skills.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { buildLemcoreImplContext } from './graph-context.js';
import { buildRepoMap } from './repo-map.js';
import { selectAgentsMd, readRootAgentsMd } from '../repo-context.js';
import { clearGraphSession } from './graph/session.js';
import { scanRepositoryGraph } from './graph-scan.js';
import { runLemcoreLoop, loadTranscript, scrubLegacyInCloneTranscript, type LemcoreMessage } from './loop.js';
import { resetTodoList } from './todo-store.js';
import { resetLoopDetection } from './loop-detector.js';
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
  repoMap = '',
): string {
  const graphBlock = implContext.trim() || scanSummary.trim();
  const mapBlock = repoMap.trim() ? `${repoMap.trim()}\n\n` : '';
  return [
    basePrompt.trimEnd(),
    '',
    mapBlock + graphBlock,
    '',
    'Use the codebase graph summary above for navigation. Prefer graph_* tools and selective file reads over dumping large source corpora.',
  ].join('\n');
}

/**
 * Build the AGENTS.md section for the lemcore prompt. The repo's own root
 * AGENTS.md wins; otherwise an injected template (an 'agents_md' skill chosen
 * for the repository) fills the gap. Mirrors selectAgentsMd from repo-context
 * (single source of truth) so lemcore and the internal executor agree on which
 * content applies.
 */
async function buildAgentsMdSection(
  task: TaskWithRepo,
  workdir: string,
): Promise<string> {
  const root = await readRootAgentsMd(workdir);
  const template = await loadAgentsMdTemplate(task.repository);
  const selected = selectAgentsMd(root, template);
  if (!selected) return '';
  const fromRoot = root !== null && root.trim().length > 0;
  const label = fromRoot ? 'AGENTS.md' : 'AGENTS.md (template)';
  return `# ${label}\n\n${selected.trim()}`;
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
  // Repo map: a stable PageRank-ranked overview of the codebase (files +
  // symbols). Prepend it to the graph block so the model always has a compact
  // structural index, even before it calls any graph tool. Only meaningful for
  // the fallback scan (which extracts symbols); code-review-graph source
  // already ships its own architecture text.
  const repoMap = graphScan.graph.fileSymbols
    ? buildRepoMap(graphScan.graph)
    : '';
  return appendGraphContext(basePrompt, graphScan.summaryText, implContext.text, repoMap);
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
    // Clear per-workdir module state (TODO list + edit checkpoints + loop
    // detection) so a long-lived worker doesn't leak the previous run's
    // state into the next (keyed by workdir to survive concurrency, not runs).
    resetTodoList(workdir);
    clearCheckpoints(workdir);
    resetLoopDetection(workdir);
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
  // Repo coding standards: inject the AGENTS.md content (root file or the
  // repository's agents_md template skill) so the agent can actually follow
  // the repo's rules — a literal "respect AGENTS.md" instruction is useless
  // when the agent never sees the file's contents. The internal executor has
  // always done this via buildRepoContext; lemcore had the gap.
  const agentsMdSection = await buildAgentsMdSection(task, workdir);
  if (agentsMdSection) prompt = `${prompt}\n\n${agentsMdSection}`;
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
  // Repo context digest: an LLM-written architecture map generated once per
  // default-branch HEAD (repo-digest.ts). Injected so the agent starts with
  // repo knowledge instead of spending exploration turns from zero.
  const digest = task.repository?.contextDigest?.trim();
  if (digest) {
    const sha = task.repository?.contextDigestSha?.slice(0, 7) ?? 'unknown';
    prompt =
      `${prompt}\n\n# Repository digest (auto-generated at ${sha}; ` +
      `a map, not ground truth — verify details with graph/grep before editing)\n${digest}`;
  }
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
    // Implementation runs gate on the project's tests before accepting the
    // final reply; promptOverride runs (CI-fix, rebase) gate too — they're
    // implementation-adjacent. Review runs skip it (they finish via the
    // review-file path and systemPromptOverride).
    verifyGate: true,
  });

  // Attachments/skills and agent scratch must not count as a produced change:
  // a run that only read files must NOT be treated as done.
  const changed = await hasMeaningfulChanges(workdir);
  return {
    summary: changed ? finalContent || task.title : null,
    changed,
  };
}
