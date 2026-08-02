import path from 'node:path';
import type { GitConnection, Repository } from '@prisma/client';
import { config } from '../config.js';
import { logger } from './logger.js';
import { cleanupWorkdir, cloneRepository } from './agent-git.js';
import {
  requestProposals,
  type LlmProposals,
  type ProposalPriority,
} from './agent-prompts.js';
import { prepareAgentRuntime } from './agent-runtime.js';
import { prisma } from './prisma.js';
import { buildRepoContext } from './repo-context.js';
import { loadAgentsMdTemplate, parseSkillSlugs } from './task-skills.js';

// Job: generate-proposals — the LLM suggests up to 5 improvement tasks for a
// repository. They are created as pending proposal tasks (click-to-run: the
// user starts each via POST /tasks/:id/start), deduped by title against
// pending/queued ones and topped up to at most MAX_PENDING_PROPOSALS.

type RepositoryWithConnection = Repository & { connection: GitConnection };

export const MAX_PENDING_PROPOSALS = 5;

type PendingProposalState = { titles: Set<string>; pendingCount: number };

// Pure core of loadPendingProposalState: dedupe titles come from ALL
// pending/queued proposals (archived ones included — don't re-propose what
// the user archived), but only non-archived pendings count toward the
// top-up cap.
export function pendingProposalState(
  rows: Array<{ title: string; status: string; archivedAt?: Date | null }>,
): PendingProposalState {
  const titles = new Set(rows.map((t) => t.title.trim().toLowerCase()));
  const pendingCount = rows.filter((t) => t.status === 'pending' && !t.archivedAt).length;
  return { titles, pendingCount };
}

// Titles of proposals already pending/queued for this repo (normalized), so
// re-runs do not pile up duplicates, plus the pending count for the top-up cap.
async function loadPendingProposalState(repositoryId: string): Promise<PendingProposalState> {
  const existing = await prisma.task.findMany({
    where: {
      repositoryId,
      kind: 'proposal',
      status: { in: ['pending', 'queued'] },
    },
    select: { title: true, status: true, archivedAt: true },
  });
  return pendingProposalState(existing);
}

const PRIORITY_RANK: Record<ProposalPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Stable sort, critical first. Pure for tests. */
export function sortByPriority(proposals: LlmProposals): LlmProposals {
  return [...proposals].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

function proposalTaskData(repository: RepositoryWithConnection, proposal: LlmProposals[number]) {
  return {
    repositoryId: repository.id,
    kind: 'proposal' as const,
    title: proposal.title,
    prompt: proposal.prompt,
    category: proposal.category,
    priority: proposal.priority,
    effort: proposal.effort,
    status: 'pending' as const,
    // Proposals inherit the repository's skills, same as prompt tasks.
    skills: parseSkillSlugs(repository.skillSlugs),
    ...(repository.llmConfigId ? { llmConfigId: repository.llmConfigId } : {}),
  };
}

// Creates new pending proposal tasks, at most enough to bring the repo back
// to MAX_PENDING_PROPOSALS pending. Nothing is enqueued — proposals wait for
// user approval. Creation runs lowest-priority first so the critical ones
// get the newest createdAt and top the UI's newest-first list.
async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const { titles, pendingCount } = await loadPendingProposalState(repository.id);
  const budget = MAX_PENDING_PROPOSALS - pendingCount;
  const ordered = sortByPriority(proposals.slice(0, MAX_PENDING_PROPOSALS)).reverse();
  let created = 0;
  for (const proposal of ordered) {
    if (created >= budget) break;
    const key = proposal.title.trim().toLowerCase();
    if (titles.has(key)) continue;
    titles.add(key);
    await prisma.task.create({ data: proposalTaskData(repository, proposal) });
    created += 1;
  }
  return created;
}

async function executeGenerateProposals(
  repository: RepositoryWithConnection,
  workdir: string,
  secrets: string[],
): Promise<void> {
  const { cloneUrl, gitAuth, rt } = await prepareAgentRuntime(null, repository, secrets);
  // Empty remotes are bootstrapped by cloneRepository's init fallback, so an
  // empty repo simply yields greenfield proposals.
  await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets, { auth: gitAuth });
  const agentsMdTemplate = await loadAgentsMdTemplate(repository);
  const { text: repoContext } = await buildRepoContext(
    workdir,
    rt.cfg.contextWindow,
    agentsMdTemplate,
  );
  const proposals = await requestProposals(rt, repository, repoContext);
  const created = await createProposalTasks(repository, proposals);
  logger.info({ repository: repository.fullName, proposed: proposals.length, created }, 'generate-proposals: done');
}

export async function generateProposals(repositoryId: string): Promise<void> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) {
    logger.error({ repositoryId }, 'generate-proposals: repository not found');
    return;
  }
  // Triggered by the round-button endpoint and the global 'proposals-topup'
  // repeatable job. Bail out before cloning when the repo is already topped
  // up — the LLM call would only produce proposals that get created: 0.
  const { pendingCount } = await loadPendingProposalState(repositoryId);
  if (pendingCount >= MAX_PENDING_PROPOSALS) {
    logger.info({ repository: repository.fullName, pending: MAX_PENDING_PROPOSALS }, 'generate-proposals: already pending, skipping');
    return;
  }

  const secrets: string[] = [];
  const workdir = path.join(config.AGENT_WORKDIR, `proposals-${repositoryId}`);
  try {
    await executeGenerateProposals(repository, workdir, secrets);
  } finally {
    await cleanupWorkdir(workdir);
  }
}

// Stamps the autonomous pipeline health on the Repository row. Called by the
// worker handler wrapper (worker.ts runGenerateProposals) after each
// generate-proposals outcome — never inside generateProposals itself, so the
// stamping has no effect on unit-tested proposal logic and the worker retains
// control over when/how the stamp is applied (including on the final retry).
// The failure message MUST be pre-scrubbed by the caller
// (scrubRepositoryFailureMessage): lastProposalError is served by
// GET /repositories and rendered in the frontend tooltip.

export async function stampProposalSuccess(repositoryId: string): Promise<void> {
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastProposalAt: new Date(), lastProposalError: null },
  });
}

const MAX_PROPOSAL_ERROR_LEN = 500;

export async function stampProposalFailure(
  repositoryId: string,
  message: string,
): Promise<void> {
  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastProposalError: message.slice(0, MAX_PROPOSAL_ERROR_LEN) },
  });
}
