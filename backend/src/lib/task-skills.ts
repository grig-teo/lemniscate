import type { Skill } from '@prisma/client';
import { z } from 'zod';
import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';

// Skills plumbing shared by the API routes and the worker: parsing the
// Json slug columns (Repository.skillSlugs, Task.skills) and resolving them
// to Skill rows for prompt injection / AGENTS.md fallback.

const skillSlugsSchema = z.array(z.string());

// The slug columns are Json in the DB; anything malformed degrades to no
// skills rather than failing the request/run.
export function parseSkillSlugs(raw: unknown): string[] {
  const parsed = skillSlugsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// Resolves the task's skill slugs to Skill rows, preserving the stored
// order. Missing slugs are skipped with a log line so a stale reference
// never fails a run.
export async function loadTaskSkills(task: { id: string; skills: unknown }): Promise<Skill[]> {
  const slugs = parseSkillSlugs(task.skills);
  if (slugs.length === 0) return [];
  const rows = await prisma.skill.findMany({ where: { slug: { in: slugs } } });
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
export async function findUnknownSkillSlugs(slugs: string[]): Promise<string[]> {
  const rows = await prisma.skill.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true },
  });
  const known = new Set(rows.map((row) => row.slug));
  return slugs.filter((slug) => !known.has(slug));
}

// MCP-server slugs from a request body that have no McpServer row — same
// 400-with-names contract as findUnknownSkillSlugs.
export async function findUnknownMcpServerSlugs(slugs: string[]): Promise<string[]> {
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: slugs } },
    select: { slug: true },
  });
  const known = new Set(rows.map((row) => row.slug));
  return slugs.filter((slug) => !known.has(slug));
}

// MCP server slug → config map for the `.mcp.json` materialization.
export async function resolveMcpServerConfigs(slugs: string[]): Promise<Record<string, unknown>> {
  if (slugs.length === 0) return {};
  const rows = await prisma.mcpServer.findMany({
    where: { slug: { in: slugs } },
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
): Promise<{ folder: string; content: string }[]> {
  const files: { folder: string; content: string }[] = [];
  for (const entry of entries) {
    const content =
      entry.content ??
      (entry.skillId ? await loadAgentsMdTemplate({ agentsMdSkillId: entry.skillId }) : null);
    if (content) files.push({ folder: entry.folder, content });
  }
  return files;
}

export async function isAgentsMdSkill(id: string): Promise<boolean> {
  const skill = await prisma.skill.findUnique({ where: { id }, select: { kind: true } });
  return skill?.kind === 'agents_md';
}

// Content of the repository's AGENTS.md template skill, or null when unset
// or when the reference dangles / points at the wrong kind (treated as "no
// template" so a stale id never fails a run).
export async function loadAgentsMdTemplate(repository: {
  agentsMdSkillId: string | null;
}): Promise<string | null> {
  if (!repository.agentsMdSkillId) return null;
  const skill = await prisma.skill.findUnique({
    where: { id: repository.agentsMdSkillId },
    select: { content: true, kind: true },
  });
  if (!skill || skill.kind !== 'agents_md') return null;
  return skill.content;
}
