import type { GitlemRepository, GitlemUser } from '@prisma/client';
import { prisma } from './prisma.js';
import { parseGitlemDoc, type GitlemRepoDoc } from './gitlem-store.js';

// Prisma-backed access helpers for the gitlem repo JSON document. The pure
// document model (types, branch/file/PR/CI operations, parse/stringify) lives
// in gitlem-store.ts; this module is the ONE home for the prisma read-modify-
// write transaction and ownership resolution (AGENTS.md §6). Split out so
// gitlem-store.ts stays under the 300-line module limit (AGENTS.md §2).

/** Error outcome of a doc mutation: abort the write and let the caller report it. */
export interface GitlemDocError {
  error: string;
  status: number;
}

export function isGitlemDocError(outcome: unknown): outcome is GitlemDocError {
  return typeof outcome === 'object' && outcome !== null && 'error' in outcome;
}

/**
 * The ONE read → parse → mutate → stringify → write transaction for a
 * repo's JSON document (shared by the ingest path, routes, and provider
 * clients). The callback returns the outcome payload, or a GitlemDocError to
 * abort without writing; a thrown error rolls the transaction back.
 */
export async function mutateGitlemRepoDoc<T>(
  repoId: string,
  mutate: (doc: GitlemRepoDoc) => T | GitlemDocError,
): Promise<T | GitlemDocError> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.gitlemRepository.findUniqueOrThrow({ where: { id: repoId } });
    const doc = parseGitlemDoc(current.doc);
    const outcome = mutate(doc);
    if (isGitlemDocError(outcome)) return outcome;
    await tx.gitlemRepository.update({
      where: { id: repoId },
      data: { doc: JSON.stringify(doc) },
    });
    return outcome;
  });
}

/**
 * Resolve '<username>/<name>' to the repository row owned by `account`,
 * failing closed (null) unless the username segment IS the account's own —
 * gitlem repos are per-account, so 'other-user/name' must never resolve to
 * the caller's same-named repo.
 */
export async function findOwnedGitlemRepo(
  account: Pick<GitlemUser, 'id' | 'username'>,
  repoFullName: string,
): Promise<GitlemRepository | null> {
  const [username, name] = repoFullName.split('/');
  if (username !== account.username || !name) return null;
  return prisma.gitlemRepository.findUnique({
    where: { ownerId_name: { ownerId: account.id, name } },
  });
}
