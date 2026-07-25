// MinIO mirror of the prompt library (skills, AGENTS.md templates, MCP
// servers): Postgres stays the source of truth for the API, every write is
// mirrored to the bucket under `skills/`, `agents-md/`, `mcp-servers/`.
// Everything here is best-effort — when MinIO is not configured or
// unreachable the caller logs a warning and continues.

import { getMinioBucket } from './minio-client.js';

export type LibraryKind = 'skill' | 'agents_md' | 'mcp_server';

const FOLDERS: Record<LibraryKind, string> = {
  skill: 'skills',
  agents_md: 'agents-md',
  mcp_server: 'mcp-servers',
};

const EXTENSIONS: Record<LibraryKind, string> = {
  skill: '.md',
  agents_md: '.md',
  mcp_server: '.json',
};

const CONTENT_TYPES: Record<LibraryKind, string> = {
  skill: 'text/markdown; charset=utf-8',
  agents_md: 'text/markdown; charset=utf-8',
  mcp_server: 'application/json; charset=utf-8',
};

/** Object key for a library entry, e.g. `skills/code-review.md`. */
export function libraryObjectKey(kind: LibraryKind, slug: string): string {
  return `${FOLDERS[kind]}/${slug}${EXTENSIONS[kind]}`;
}

// Bucket from config (default 'lemniscate-library'); the client itself lives
// in minio-client.ts (single home, shared with device-artifacts).
async function getClient(): Promise<{ client: import('minio').Client; bucket: string } | null> {
  const { config } = await import('../config.js');
  const ctx = await getMinioBucket(config.MINIO_BUCKET);
  return ctx ? { client: ctx.client, bucket: config.MINIO_BUCKET } : null;
}

/** Mirror one library entry to MinIO; failures are logged, never thrown. */
export async function mirrorLibraryObject(
  kind: LibraryKind,
  slug: string,
  content: string,
  log: { warn: (msg: string) => void },
): Promise<void> {
  try {
    const ctx = await getClient();
    if (!ctx) return;
    await ctx.client.putObject(ctx.bucket, libraryObjectKey(kind, slug), content, undefined, {
      'Content-Type': CONTENT_TYPES[kind],
    });
  } catch (err) {
    log.warn(`minio mirror failed for ${libraryObjectKey(kind, slug)}: ${String(err)}`);
  }
}

/** Remove a mirrored library entry; failures are logged, never thrown. */
export async function removeLibraryObject(
  kind: LibraryKind,
  slug: string,
  log: { warn: (msg: string) => void },
): Promise<void> {
  try {
    const ctx = await getClient();
    if (!ctx) return;
    await ctx.client.removeObject(ctx.bucket, libraryObjectKey(kind, slug));
  } catch (err) {
    log.warn(`minio remove failed for ${libraryObjectKey(kind, slug)}: ${String(err)}`);
  }
}
