import type { GitConnection } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import {
  getProviderClient,
  isBareRootListing,
  type GitProviderClient,
  type NormalizedRepo,
} from './git-providers.js';
import { prisma } from './prisma.js';
import { detectRepoPlatform } from './repo-platform.js';
import { errorMessage } from './utils.js';

// Single home for repository sync: pulls the provider's repo list and
// upserts Repository rows keyed by (connectionId, externalId).

export interface SyncResult {
  synced: number;
  created: number;
  updated: number;
}

interface RepoMeta {
  bare?: boolean;
  platform?: string;
}

// Best-effort root-listing probe: empty object means "check failed — keep
// the previously stored values" (they are left out of the upsert entirely).
async function detectRepoMeta(
  client: GitProviderClient,
  repoFullName: string,
): Promise<RepoMeta> {
  try {
    const entries = await client.listRootEntries(repoFullName);
    return { bare: isBareRootListing(entries), platform: detectRepoPlatform(entries) };
  } catch {
    return {};
  }
}

// Upserts one provider repo; returns true when an existing row was updated.
async function upsertRepository(
  connectionId: string,
  repo: NormalizedRepo,
  meta: RepoMeta,
): Promise<boolean> {
  const key = { connectionId, externalId: repo.externalId };
  const existing = await prisma.repository.findUnique({
    where: { connectionId_externalId: key },
    select: { id: true },
  });
  const metaData = {
    ...(meta.bare === undefined ? {} : { bare: meta.bare }),
    ...(meta.platform === undefined ? {} : { platform: meta.platform }),
  };
  await prisma.repository.upsert({
    where: { connectionId_externalId: key },
    create: { connectionId, ...repo, ...metaData },
    update: {
      name: repo.name,
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      ...metaData,
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
    const meta = await detectRepoMeta(client, repo.fullName);
    if (await upsertRepository(connection.id, repo, meta)) updated += 1;
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
