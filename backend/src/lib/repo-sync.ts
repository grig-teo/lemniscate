import type { GitConnection } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { getProviderClient, type NormalizedRepo } from './git-providers.js';
import { prisma } from './prisma.js';
import { errorMessage } from './utils.js';

// Single home for repository sync: pulls the provider's repo list and
// upserts Repository rows keyed by (connectionId, externalId).

export interface SyncResult {
  synced: number;
  created: number;
  updated: number;
}

// Upserts one provider repo; returns true when an existing row was updated.
async function upsertRepository(connectionId: string, repo: NormalizedRepo): Promise<boolean> {
  const key = { connectionId, externalId: repo.externalId };
  const existing = await prisma.repository.findUnique({
    where: { connectionId_externalId: key },
    select: { id: true },
  });
  await prisma.repository.upsert({
    where: { connectionId_externalId: key },
    create: { connectionId, ...repo },
    update: {
      name: repo.name,
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
    },
  });
  return existing !== null;
}

export async function syncConnectionRepositories(connection: GitConnection): Promise<SyncResult> {
  const repos = await getProviderClient(connection).listRepos();
  let created = 0;
  let updated = 0;
  for (const repo of repos) {
    if (await upsertRepository(connection.id, repo)) updated += 1;
    else created += 1;
  }
  return { synced: repos.length, created, updated };
}

// Best-effort variant for connect/login flows: a failed sync must not break
// the connect itself — the user can always re-sync from the UI.
export async function syncConnectionByIdBestEffort(
  connectionId: string,
  log?: FastifyBaseLogger,
): Promise<void> {
  const connection = await prisma.gitConnection.findUnique({ where: { id: connectionId } });
  if (!connection) return;
  try {
    await syncConnectionRepositories(connection);
  } catch (err) {
    log?.warn({ err }, `repository sync after connect failed: ${errorMessage(err)}`);
  }
}
