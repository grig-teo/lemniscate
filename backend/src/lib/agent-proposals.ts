import path from 'node:path';
import type { GitConnection, Repository } from '@prisma/client';
import { config } from '../config.js';
import { cleanupWorkdir, cloneRepository } from './agent-git.js';
import { requestProposals, type LlmProposals } from './agent-prompts.js';
import { prepareAgentRuntime } from './agent-runtime.js';
import { prisma } from './prisma.js';
import { buildRepoContext } from './repo-context.js';

// Job: generate-proposals — the LLM suggests up to 5 improvement tasks for a
// repository. They are created as pending proposal tasks (click-to-run: the
// user starts each via POST /tasks/:id/start), deduped by title against
// pending/queued ones and topped up to at most MAX_PENDING_PROPOSALS pending.
// Extracted from agent-loop.ts.

type RepositoryWithConnection = Repository & { connection: GitConnection };

export const MAX_PENDING_PROPOSALS = 5;

type PendingProposalState = { titles: Set<string>; pendingCount: number };

// Titles of proposals already pending/queued for this repo (normalized), so
// re-runs do not pile up duplicates, plus the pending count for the top-up cap.
async function loadPendingProposalState(repositoryId: string): Promise<PendingProposalState> {
  const existing = await prisma.task.findMany({
    where: {
      repositoryId,
      kind: 'proposal',
      status: { in: ['pending', 'queued'] },
    },
    select: { title: true, status: true },
  });
  const titles = new Set(existing.map((t) => t.title.trim().toLowerCase()));
  const pendingCount = existing.filter((t) => t.status === 'pending').length;
  return { titles, pendingCount };
}

function proposalTaskData(repository: RepositoryWithConnection, proposal: LlmProposals[number]) {
  return {
    repositoryId: repository.id,
    kind: 'proposal' as const,
    title: proposal.title,
    prompt: proposal.prompt,
    status: 'pending' as const,
    ...(repository.llmConfigId ? { llmConfigId: repository.llmConfigId } : {}),
  };
}

// Creates new pending proposal tasks, at most enough to bring the repo back
// to MAX_PENDING_PROPOSALS pending. Nothing is enqueued — proposals wait for
// user approval.
async function createProposalTasks(
  repository: RepositoryWithConnection,
  proposals: LlmProposals,
): Promise<number> {
  const { titles, pendingCount } = await loadPendingProposalState(repository.id);
  const budget = MAX_PENDING_PROPOSALS - pendingCount;
  let created = 0;
  for (const proposal of proposals.slice(0, MAX_PENDING_PROPOSALS)) {
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
  const { cloneUrl, rt } = await prepareAgentRuntime(null, repository, secrets);
  // Empty remotes are bootstrapped by cloneRepository's init fallback, so an
  // empty repo simply yields greenfield proposals.
  await cloneRepository(workdir, cloneUrl, repository.defaultBranch, secrets);
  const { text: repoContext } = await buildRepoContext(workdir, rt.cfg.contextWindow);
  const proposals = await requestProposals(rt, repository, repoContext);
  const created = await createProposalTasks(repository, proposals);
  console.log(
    `generate-proposals: ${repository.fullName}: ${proposals.length} proposed, ${created} created`,
  );
}

export async function generateProposals(repositoryId: string): Promise<void> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { connection: true },
  });
  if (!repository) {
    console.error(`generate-proposals: repository ${repositoryId} not found`);
    return;
  }
  // Triggered by the round-button endpoint and the global 'proposals-topup'
  // repeatable job. Bail out before cloning when the repo is already topped
  // up — the LLM call would only produce proposals that get created: 0.
  const { pendingCount } = await loadPendingProposalState(repositoryId);
  if (pendingCount >= MAX_PENDING_PROPOSALS) {
    console.log(
      `generate-proposals: ${repository.fullName}: ${MAX_PENDING_PROPOSALS} proposals already pending, skipping`,
    );
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
