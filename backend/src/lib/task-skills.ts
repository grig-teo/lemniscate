import type { Skill } from '@prisma/client';
import { z } from 'zod';
import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';

// Skills plumbing shared by the API routes and the worker: parsing the
// Json slug columns (Repository.skillSlugs, Task.skills) and resolving them
// to Skill rows for prompt injection / AGENTS.md fallback.
//
// Library rows are either global (userId NULL, seeded) or user-owned. Every
// query takes an optional trailing userId: when given, it is scoped to
// global + that user's rows; when omitted (worker paths and legacy callers)
// the query keeps the old unscoped behavior.

const skillSlugsSchema = z.array(z.string());

// Prisma where-fragment for "visible to this user": global rows plus the
// user's own. Empty object without a userId = unscoped (legacy).
export function libraryScopeWhere(userId?: string) {
  return userId ? { OR: [{ userId: null }, { userId }] } : {};
}

// Ownership check for library mutations (PUT/DELETE): only the owner may
// change a row; global seeded rows and other users' rows are forbidden.
// Returns the 403 message, or null when the mutation is allowed.
export function libraryMutationBlocker(
  entryUserId: string | null,
  userId: string,
): string | null {
  if (entryUserId === userId) return null;
  return entryUserId === null
    ? 'Global library entries cannot be modified'
    : 'This library entry belongs to another user';
}

// The slug columns are Json in the DB; anything malformed degrades to no
// skills rather than failing the request/run.
export function parseSkillSlugs(raw: unknown): string[] {
  const parsed = skillSlugsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// Resolves the task's skill slugs to Skill rows, preserving the stored
// order. Missing slugs are skipped with a log line so a stale reference
// never fails a run.
export async function loadTaskSkills(
  task: { id: string; skills: unknown },
  userId?: string,
): Promise<Skill[]> {
  const slugs = parseSkillSlugs(task.skills);
  if (slugs.length === 0) return [];
  const rows = await prisma.skill.findMany({
    where: { slug: { in: slugs }, ...libraryScopeWhere(userId) },
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const skills: Skill[] = [];
  for (const slug of slugs) {
    const row = bySlug.get(slug);
    if (!row) {
      await logEvent(task.id, `skill "${slug}" not found, skipping`);
      continue;
    }
    skills.push(row);
  }
  return skills;
}

// Slugs from a request body that have no Skill row — used to 400 with the
// offending names instead of silently storing dead references. Shared by the
// repository PATCH and the repo-creation route.
export async function findUnknownSkillSlugs(slugs: string[], userId?: string): Promise<string[]> {
  const rows = await prisma.skill.findMany({
    where: { slug: { in: slugs }, ...libraryScopeWhere(userId) },
    select: { slug: true },
  });
  const known = new Set(rows.map((row) => row.slug));
  return slugs.filter((slug) => !known.has(slug));
}

// MCP-server slugs from a request body that have no McpServer row — same
// 400-with-names contract as findUnknownSkillSlugs.
export async function findUnknownMcpServerSlugs(
  slugs: string[],
  userId?: string,
): Promise<string[]> {
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: slugs }, ...libraryScopeWhere(userId) },
    select: { slug: true },
  });
  const known = new Set(rows.map((row) => row.slug));
  return slugs.filter((slug) => !known.has(slug));
}

// MCP server slug → config map for the `.mcp.json` materialization.
export async function resolveMcpServerConfigs(
  slugs: string[],
  userId?: string,
): Promise<Record<string, unknown>> {
  if (slugs.length === 0) return {};
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: slugs }, ...libraryScopeWhere(userId) },
    select: { slug: true, config: true },
  });
  return Object.fromEntries(rows.map((row) => [row.slug, row.config]));
}

export interface AgentsMdFileInput {
  folder: string;
  skillId?: string;
  content?: string;
}

// Per-folder AGENTS.md entries with the template content inlined: an uploaded
// custom text wins over the referenced template skill. Entries with neither
// are dropped.
export async function resolveAgentsMdFileContents(
  entries: AgentsMdFileInput[],
  userId?: string,
): Promise<{ folder: string; content: string }[]> {
  const files: { folder: string; content: string }[] = [];
  for (const entry of entries) {
    const content =
      entry.content ??
      (entry.skillId
        ? await loadAgentsMdTemplate({ agentsMdSkillId: entry.skillId }, userId)
        : null);
    if (content) files.push({ folder: entry.folder, content });
  }
  return files;
}

export async function isAgentsMdSkill(id: string, userId?: string): Promise<boolean> {
  const skill = await prisma.skill.findUnique({
    where: { id },
    select: { kind: true, userId: true },
  });
  if (skill?.kind !== 'agents_md') return false;
  if (!userId) return true;
  return skill.userId === null || skill.userId === userId;
}

// Content of the repository's AGENTS.md template skill, or null when unset,
// when the reference dangles / points at the wrong kind, or when the row is
// not visible to the given user (treated as "no template" so a stale id
// never fails a run).
export async function loadAgentsMdTemplate(
  repository: { agentsMdSkillId: string | null },
  userId?: string,
): Promise<string | null> {
  if (!repository.agentsMdSkillId) return null;
  const skill = await prisma.skill.findUnique({
    where: { id: repository.agentsMdSkillId },
    select: { content: true, kind: true, userId: true },
  });
  if (!skill || skill.kind !== 'agents_md') return null;
  if (userId && skill.userId !== null && skill.userId !== userId) return null;
  return skill.content;
}
