import type { GitConnection } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  getProviderClient,
  type GitProviderClient,
  type NormalizedRepo,
} from './git-providers.js';
import { prisma } from './prisma.js';
import { errorMessage } from './utils.js';

// Single home for repository sync: pulls the provider's repo list and
// upserts Repository rows keyed by (connectionId, externalId).

export interface SyncResult {
  synced: number;
  created: number;
  updated: number;
}

// Best-effort bare probe: undefined means "check failed — keep the
// previously stored value" (the flag is left out of the upsert entirely).
async function detectBare(
  client: GitProviderClient,
  repoFullName: string,
): Promise<boolean | undefined> {
  try {
    return await client.isBare(repoFullName);
  } catch {
    return undefined;
  }
}

// Upserts one provider repo; returns true when an existing row was updated.
async function upsertRepository(
  connectionId: string,
  repo: NormalizedRepo,
  bare: boolean | undefined,
): Promise<boolean> {
  const key = { connectionId, externalId: repo.externalId };
  const existing = await prisma.repository.findUnique({
    where: { connectionId_externalId: key },
    select: { id: true },
  });
  const bareData = bare === undefined ? {} : { bare };
  await prisma.repository.upsert({
    where: { connectionId_externalId: key },
    create: { connectionId, ...repo, ...bareData },
    update: {
      name: repo.name,
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      ...bareData,
    },
  });
  return existing !== null;
}

export async function syncConnectionRepositories(connection: GitConnection): Promise<SyncResult> {
  const client = getProviderClient(connection);
  const repos = await client.listRepos();
  let created = 0;
  let updated = 0;
  for (const repo of repos) {
    const bare = await detectBare(client, repo.fullName);
    if (await upsertRepository(connection.id, repo, bare)) updated += 1;
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
