import { Prisma } from '@prisma/client';
import type { ProviderName } from '../lib/git-providers.js';
import { prisma } from '../lib/prisma.js';
import { connectionSelect, type ConnectionView } from './connection-schemas.js';

// PAT identity store: the (provider, username, baseUrl) triple is unique
// across the whole table, so all PAT upsert paths funnel through these
// helpers (single home for the unique-conflict rules — AGENTS.md §6).

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

// The PAT identity behind a (provider, username, baseUrl) triple, regardless
// of owner — the triple is unique across the whole table.
export async function findPatIdentity(
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
) {
  return prisma.gitConnection.findFirst({
    where: { provider, username, baseUrl: baseUrl ?? null },
  });
}

// A PAT replaces any OAuth tokens: clear the refresh flow's fields.
// PAT (re)connect always reactivates the row (a soft-disconnected connection
// becomes active again) and clears the OAuth-only refresh fields.
const PAT_TOKEN_FIELDS = {
  tokenType: 'pat',
  refreshTokenEnc: null,
  tokenExpiresAt: null,
  disconnectedAt: null,
} as const;

// Authenticated path: the connection belongs to the session user. Returns
// null when the PAT identity is already owned by a DIFFERENT user (the
// caller 409s); a same-user unique race degrades to a token update.
export async function upsertAuthenticatedConnection(
  userId: string,
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
): Promise<{ connection: ConnectionView; created: boolean } | null> {
  const existing = await prisma.gitConnection.findFirst({
    where: { userId, provider, username, baseUrl: baseUrl ?? null },
  });
  if (existing) {
    const connection = await prisma.gitConnection.update({
      where: { id: existing.id },
      data: { accessTokenEnc, ...PAT_TOKEN_FIELDS },
      select: connectionSelect,
    });
    return { connection, created: false };
  }
  try {
    const connection = await prisma.gitConnection.create({
      data: { userId, provider, username, baseUrl: baseUrl ?? null, accessTokenEnc },
      select: connectionSelect,
    });
    return { connection, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return resolveUniqueConflict(userId, provider, username, baseUrl, accessTokenEnc);
  }
}

// P2002 recovery: the identity row exists but is not scoped to this user —
// attach to it when it turns out to be theirs (concurrent-connect race),
// otherwise report the conflict so the caller can 409.
async function resolveUniqueConflict(
  userId: string,
  provider: ProviderName,
  username: string,
  baseUrl: string | undefined,
  accessTokenEnc: string,
): Promise<{ connection: ConnectionView; created: boolean } | null> {
  const conflict = await findPatIdentity(provider, username, baseUrl);
  if (!conflict || conflict.userId !== userId) return null;
  const connection = await prisma.gitConnection.update({
    where: { id: conflict.id },
    data: { accessTokenEnc, ...PAT_TOKEN_FIELDS },
    select: connectionSelect,
  });
  return { connection, created: false };
}

// Unauthenticated path: the PAT is the credential — reactivate the identity
// row with the fresh token. The caller starts the session.
export async function reactivatePatIdentity(
  existingId: string,
  accessTokenEnc: string,
): Promise<ConnectionView> {
  return prisma.gitConnection.update({
    where: { id: existingId },
    data: { accessTokenEnc, ...PAT_TOKEN_FIELDS },
    select: connectionSelect,
  });
}
