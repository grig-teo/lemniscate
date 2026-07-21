// Seeds the Skill table from github.com/NousResearch/hermes-agent:
// `skills/<category>/<slug>/SKILL.md` and `optional-skills/<category>/<slug>/SKILL.md`
// become kind 'skill' rows; two AGENTS.md templates (this repo's root
// AGENTS.md and the cloned repo's) become kind 'agents_md' rows.
//
// Idempotent: every row is upserted by slug, so re-running refreshes content
// in place. Run with `npm run seed:skills` (requires DATABASE_URL and git).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../dist/lib/prisma.js';
import { parseSkillFrontmatter } from '../dist/lib/skill-frontmatter.js';

const REPO_URL = 'https://github.com/NousResearch/hermes-agent';
const SKILL_ROOTS = ['skills', 'optional-skills'] as const;
// Category-level dirs in the upstream repo that are not real skill packs.
const SKIPPED_CATEGORIES = new Set(['index-cache', 'dogfood', 'hermes-desktop-plugins']);

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lemniscateRoot = resolve(backendRoot, '..');

interface SkillRow {
  slug: string;
  name: string;
  category: string;
  description: string;
  content: string;
  tags: string[];
  source: string;
  kind: string;
}

function cloneRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-agent-'));
  execFileSync('git', ['clone', '--depth', '1', REPO_URL, dir], { stdio: 'inherit' });
  return dir;
}

// Collects one row per `<root>/<category>/<slug>/SKILL.md`. Files without a
// parseable frontmatter (name + description) are skipped.
function collectSkills(repoDir: string): SkillRow[] {
  const rows: SkillRow[] = [];
  for (const root of SKILL_ROOTS) {
    const rootDir = join(repoDir, root);
    if (!existsSync(rootDir)) continue;
    for (const category of readdirSync(rootDir, { withFileTypes: true })) {
      if (!category.isDirectory() || SKIPPED_CATEGORIES.has(category.name)) continue;
      const categoryDir = join(rootDir, category.name);
      for (const slug of readdirSync(categoryDir, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue;
        const file = join(categoryDir, slug.name, 'SKILL.md');
        if (!existsSync(file)) continue;
        const parsed = parseSkillFrontmatter(readFileSync(file, 'utf8'));
        if (parsed === null) continue;
        rows.push({
          slug: slug.name,
          name: parsed.name,
          category: category.name,
          description: parsed.description,
          content: parsed.content,
          tags: parsed.tags,
          source: 'hermes',
          kind: 'skill',
        });
      }
    }
  }
  return rows;
}

function collectAgentsMdTemplates(repoDir: string): SkillRow[] {
  return [
    {
      slug: 'default-lemniscate-agents-md',
      name: 'Lemniscate default AGENTS.md',
      category: 'agents-md',
      description: "Lemniscate's own coding standards, used as AGENTS.md when a repository root lacks one.",
      content: readFileSync(join(lemniscateRoot, 'AGENTS.md'), 'utf8').trim(),
      tags: [],
      source: 'lemniscate',
      kind: 'agents_md',
    },
    {
      slug: 'hermes-agent-agents-md',
      name: 'Hermes Agent AGENTS.md',
      category: 'agents-md',
      description: 'AGENTS.md from NousResearch/hermes-agent, used as AGENTS.md when a repository root lacks one.',
      content: readFileSync(join(repoDir, 'AGENTS.md'), 'utf8').trim(),
      tags: [],
      source: 'hermes',
      kind: 'agents_md',
    },
  ];
}

async function upsertAll(rows: SkillRow[]): Promise<void> {
  for (const row of rows) {
    await prisma.skill.upsert({
      where: { slug: row.slug },
      create: row,
      update: row,
    });
  }
}

async function main(): Promise<void> {
  const repoDir = cloneRepo();
  try {
    const skills = collectSkills(repoDir);
    const templates = collectAgentsMdTemplates(repoDir);
    await upsertAll([...skills, ...templates]);
    console.log(`seeded ${skills.length} skills and ${templates.length} agents_md templates`);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    await prisma.$disconnect();
  }
}

await main();
