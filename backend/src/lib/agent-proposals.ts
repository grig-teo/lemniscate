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
import { prepareAgentRuntime, type LlmRuntime } from './agent-runtime.js';
import { defaultAgentExecutor, resolveAgentExecutor } from './agent-executor.js';
import { runLemcoreTask } from './lemcore/run.js';
import { buildSkillsSection } from './agent-prompts.js';
import { extractJsonArray } from './llm-json.js';
import { prisma } from './prisma.js';
import { buildRepoContext } from './repo-context.js';
import { loadAgentsMdTemplate } from './task-skills.js';
import { publishTaskEvent } from './task-events.js';

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
  active: number;
  pendingTitles: Set<string>;
}

export function pendingProposalState(
  rows: { title: string; status: string }[],
): PendingProposalState {
  return {
    active: rows.length,
    pendingTitles: new Set(rows.map((row) => row.title.toLowerCase())),
  };
}

async function loadPendingProposalState(repositoryId: string): Promise<PendingProposalState> {
  const rows = await prisma.task.findMany({
    where: {
      repositoryId,
      proposal: true,
      status: { in: ['pending', 'running', 'retrying', 'waiting_approval'] },
    },
    select: { title: true, status: true },
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
    title: proposal.title.slice(0, 200),
    prompt: proposal.prompt,
    proposal: true,
    priority: proposal.priority,
    category: proposal.category,
    effort: proposal.effort,
    status: 'pending' as const,
    skills: loadAgentsMdTemplate(),
  };
}

async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const { active, pendingTitles } = await loadPendingProposalState(repository.id);
  const capacity = Math.max(0, MAX_PENDING_PROPOSALS - active);
  const fresh = sortByPriority(proposals)
    .filter((p) => !pendingTitles.has(p.title.toLowerCase()))
    .slice(0, capacity);
  if (fresh.length === 0) return 0;
  await prisma.task.createMany({
    data: fresh.map((p) => proposalTaskData(repository, p)),
  });
  return fresh.length;
}

async function loadRepositorySkills(repository: RepositoryWithConnection): Promise<Skill[]> {
  const slugs = parseSkillSlugs(repository.skillSlugs);
  if (slugs.length === 0) return [];
  const rows = await prisma.skill.findMany({ where: { slug: { in: slugs } } });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  return slugs.flatMap((slug) => bySlug.get(slug) ?? []);
}

async function readLemcoreProposalsFile(workdir: string): Promise<LlmProposals | null> {
  const file = path.join(workdir, PROPOSALS_FILENAME);
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  await fs.rm(file, { force: true });
  return text === null ? null : parseProposalsFile(text);
}

async function requestProposalsViaLemcore(
  repository: RepositoryWithConnection,
  rt: LlmRuntime,
  workdir: string,
  secrets: string[],
): Promise<LlmProposals | null> {
  const skills = await loadRepositorySkills(repository);
  await runLemcoreTask({
    taskId: null,
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
  const workdir = path.join(config.AGENT_WORKDIR, `proposals-${repository.id}-${Date.now()}`);
  const secrets: string[] = [];
  let rt: LlmRuntime | null = null;
  try {
    const { cloneUrl, auth } = await cloneRepository(repository, workdir, secrets);
    await git(['checkout', repository.defaultBranch], { cwd: workdir, secrets, auth });
    void cloneUrl;
    rt = await prepareAgentRuntime(repository);
    const proposals = await generateProposalList(repository, rt, workdir, secrets);
    const created = await createProposalTasks(repository, proposals);
    return { proposals, created };
  } finally {
    if (rt) await persistProposalTokens(repository.id, rt);
    await cleanupWorkdir(workdir, secrets);
  }
}

async function persistProposalTokens(repositoryId: string, rt: LlmRuntime): Promise<void> {
  await persistTokenUsage({} as never, rt);
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
