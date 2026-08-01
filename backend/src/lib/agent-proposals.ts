import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitConnection, Repository, Skill } from '@prisma/client';
import { config } from '../config.js';
import { logger } from './logger.js';
import { cleanupWorkdir, cloneRepository } from './agent-git.js';
import {
  featuresProposalGuidanceLines,
  llmProposalsSchema,
  PROPOSAL_CATEGORIES,
  proposalJsonContractLines,
  type LlmProposals,
  type ProposalPriority,
} from './proposals-contract.js';
import {
  prepareAgentRuntime,
  type LlmRuntime,
  type TaskWithRepo,
} from './agent-runtime.js';
import { resolveAgentExecutor } from './agent-executor.js';
import { runLemcoreTask } from './lemcore/run.js';
import { buildSkillsSection } from './agent-prompts.js';
import { extractJsonArray } from './llm-json.js';
import { prisma } from './prisma.js';
import { parseSkillSlugs } from './task-skills.js';

// Job: generate-proposals — clone → lemcore analyzes the repo → proposal
// tasks (dedupe by title, cap per repo). Extracted from agent-loop.ts.

export const MAX_PENDING_PROPOSALS = 5;

const PROPOSALS_FILENAME = '.lemniscate-proposals.json';

type RepositoryWithConnection = Repository & { connection: GitConnection };

export interface LemcoreProposalPromptOptions {
  fullName: string;
  defaultBranch: string;
  systemPromptExtra: string | null;
  repoContext: string;
  skillsSection: string;
}

export function buildLemcoreProposalPrompt(opts: LemcoreProposalPromptOptions): string {
  return [
    `You are a senior software architect and product consultant reviewing the repository '${opts.fullName}' (branch '${opts.defaultBranch}').`,
    `The current directory is a clone of the repository.${opts.skillsSection ? `\n\n${opts.skillsSection}` : ''}`,
    '',
    'Explore the codebase with the available tools. Analyze the code and propose up to 5 concrete, URGENT improvements this repository genuinely needs — do not pad with filler or cosmetic tweaks.',
    `Categorize each proposal under exactly one of: ${PROPOSAL_CATEGORIES.join(', ')}.`,
    'Cover DIFFERENT categories across the proposals.',
    ...featuresProposalGuidanceLines(),
    'Order the proposals by priority, critical first.',
    '',
    `When you are done, write your final answer as STRICT JSON (no markdown fences, no commentary) to the file ${PROPOSALS_FILENAME}, a JSON array matching:`,
    ...proposalJsonContractLines(),
    '',
    `Do NOT git commit, push, or create branches. Do NOT modify any file other than ${PROPOSALS_FILENAME}.`,
    ...(opts.systemPromptExtra
      ? ['', 'Additional instructions from the repository owner:', opts.systemPromptExtra]
      : []),
  ].join('\n');
}

export function parseProposalsFile(raw: string): LlmProposals | null {
  try {
    const parsed = llmProposalsSchema.safeParse(extractJsonArray(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface PendingProposalState {
  /** Non-archived pending proposals — these fill the top-up cap. */
  pendingCount: number;
  /** All matching titles (archived included) — never re-propose these. */
  titles: Set<string>;
}

export function pendingProposalState(
  rows: { title: string; status: string; archivedAt?: Date | null }[],
): PendingProposalState {
  return {
    pendingCount: rows.filter((row) => row.status === 'pending' && !row.archivedAt).length,
    titles: new Set(rows.map((row) => row.title.trim().toLowerCase())),
  };
}

async function loadPendingProposalState(repositoryId: string): Promise<PendingProposalState> {
  const rows = await prisma.task.findMany({
    where: {
      repositoryId,
      kind: 'proposal',
      status: { in: ['pending', 'queued', 'running'] },
    },
    select: { title: true, status: true, archivedAt: true },
  });
  return pendingProposalState(rows);
}

const PRIORITY_ORDER: ProposalPriority[] = ['critical', 'high', 'medium', 'low'];

export function sortByPriority(proposals: LlmProposals): LlmProposals {
  return [...proposals].sort(
    (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
  );
}

function proposalTaskData(repository: RepositoryWithConnection, proposal: LlmProposals[number]) {
  return {
    repositoryId: repository.id,
    kind: 'proposal' as const,
    title: proposal.title.slice(0, 200),
    prompt: proposal.prompt,
    category: proposal.category,
    priority: proposal.priority,
    effort: proposal.effort,
    status: 'pending' as const,
    // Inherit the repository's LLM config and skill selection so running a
    // proposal behaves like any task created from this repo's UI.
    ...(repository.llmConfigId ? { llmConfigId: repository.llmConfigId } : {}),
    skills: parseSkillSlugs(repository.skillSlugs),
  };
}

async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const { pendingCount, titles } = await loadPendingProposalState(repository.id);
  const capacity = Math.max(0, MAX_PENDING_PROPOSALS - pendingCount);
  // Lowest priority first: sequential creation gives critical proposals the
  // newest createdAt, topping the UI's newest-first proposal list.
  const fresh = sortByPriority(proposals)
    .filter((p) => !titles.has(p.title.trim().toLowerCase()))
    .slice(0, capacity)
    .reverse();
  for (const proposal of fresh) {
    await prisma.task.create({ data: proposalTaskData(repository, proposal) });
  }
  return fresh.length;
}

async function loadRepositorySkills(repository: RepositoryWithConnection): Promise<Skill[]> {
  const slugs = parseSkillSlugs(repository.skillSlugs);
  if (slugs.length === 0) return [];
  const rows = await prisma.skill.findMany({ where: { slug: { in: slugs } } });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return slugs.flatMap((slug: string) => bySlug.get(slug) ?? []);
}

async function readLemcoreProposalsFile(workdir: string): Promise<LlmProposals | null> {
  const file = path.join(workdir, PROPOSALS_FILENAME);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  await fs.rm(file, { force: true });
  return text === null ? null : parseProposalsFile(text);
}

// Synthetic task context for the task-less lemcore run below: the prompt
// carries the full instructions (promptOverride), so the stub only feeds the
// loop's system-prompt header / skills materialization / summary fallback.
// The taskId is namespaced so log lines land on a dedicated channel instead
// of colliding with a real task's event history.
function proposalRunStub(
  repository: RepositoryWithConnection,
  skills: Skill[],
): { taskId: string; task: TaskWithRepo } {
  const taskId = `proposals-${repository.id}`;
  const task = {
    id: taskId,
    repositoryId: repository.id,
    kind: 'proposal',
    title: `Generate proposals for ${repository.fullName}`,
    prompt: null,
    skills,
  } as unknown as TaskWithRepo;
  return { taskId, task };
}

async function requestProposalsViaLemcore(
  repository: RepositoryWithConnection,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<LlmProposals | null> {
  const skills = await loadRepositorySkills(repository);
  const { taskId, task } = proposalRunStub(repository, skills);
  await runLemcoreTask({
    taskId,
    task,
    workdir,
    rt,
    secrets,
    resume: false,
    promptOverride: buildLemcoreProposalPrompt({
      fullName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      systemPromptExtra: rt.cfg.systemPromptExtra,
      repoContext: '',
      skillsSection: buildSkillsSection(skills),
    }),
  });
  return readLemcoreProposalsFile(workdir);
}

async function generateProposalList(
  repository: RepositoryWithConnection,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<LlmProposals> {
  const executor = await resolveAgentExecutor(repository.connection.userId);
  if (executor !== 'lemcore') {
    throw new Error(`unsupported executor '${executor}' for proposal generation`);
  }
  const proposals = await requestProposalsViaLemcore(repository, rt, workdir, secrets);
  if (proposals) return proposals;
  throw new Error('lemcore produced no usable proposals file');
}

async function executeGenerateProposals(
  repository: RepositoryWithConnection,
): Promise<{ proposals: LlmProposals; created: number }> {
  // Cheap pre-check: when the cap is already full there is nothing to do, so
  // skip the clone + LLM spend entirely.
  const { pendingCount } = await loadPendingProposalState(repository.id);
  if (pendingCount >= MAX_PENDING_PROPOSALS) return { proposals: [], created: 0 };

  const workdir = path.join(config.AGENT_WORKDIR, `proposals-${repository.id}-${Date.now()}`);
  const secrets: string[] = [];
  try {
    const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(null, repository, secrets);
    await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets, {
      auth: gitAuth,
    });
    const proposals = await generateProposalList(repository, rt, workdir, secrets);
    const created = await createProposalTasks(repository, proposals);
    return { proposals, created };
  } finally {
    await cleanupWorkdir(workdir);
  }
}

export async function generateProposals(repositoryId: string): Promise<void> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) throw new Error(`repository ${repositoryId} not found`);
  const { proposals, created } = await executeGenerateProposals(repository);
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastProposalAt: new Date() },
  });
  logger.info(
    { repositoryId, proposals: proposals.length, created },
    'generated repository proposals',
  );
}

export async function stampProposalSuccess(repositoryId: string): Promise<void> {
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastProposalAt: new Date(), lastProposalError: null },
  });
}

export async function stampProposalFailure(
  repositoryId: string,
  message: string,
): Promise<void> {
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastProposalError: message.slice(0, 500) },
  });
}
