import { promises as fs } from 'node:fs';
import path from 'node:path';

// Repo-context building for the agent loop: the repository file tree plus
// the contents of its key files, budgeted to the LLM's context window.
// Extracted from agent-loop.ts; fs-only (no config/prisma/redis), so it is
// unit-testable against a temp directory.

// chars/4 ≈ tokens; we spend at most half the context window on repo context
// so the prompt and response still fit.
const CONTEXT_BUDGET_FRACTION = 0.5;
const MAX_TREE_ENTRIES = 1500;
const MAX_TREE_CHARS = 20_000;
const MAX_KEY_FILE_CHARS = 8_000;
const MAX_KEY_FILE_BYTES = 200_000;
const MAX_AGENTS_MD_CHARS = 12_000;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svg',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.jar', '.war', '.class', '.pyc',
  '.wasm', '.db', '.sqlite',
]);

const KEY_BASENAMES = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'gemfile',
  'tsconfig.json',
  'dockerfile',
  'makefile',
  'justfile',
  '.env.example',
  '.env.sample',
]);
const ENTRY_POINT_PATTERN =
  /^(src\/)?(index|main|app|server|mod)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|php)$/;
const GO_CMD_PATTERN = /^cmd\/[^/]+\/main\.go$/;

export function contextBudgetChars(contextWindowTokens: number): number {
  return Math.max(4_000, Math.floor(contextWindowTokens * 4 * CONTEXT_BUDGET_FRACTION));
}

export function isKeyFile(rel: string): boolean {
  const parts = rel.split('/');
  const depth = parts.length - 1;
  const lowerBase = (parts[parts.length - 1] ?? '').toLowerCase();
  if (depth <= 1 && /^readme(\..*)?$/.test(lowerBase)) return true;
  if (depth <= 2 && KEY_BASENAMES.has(lowerBase)) return true;
  if (ENTRY_POINT_PATTERN.test(rel)) return true;
  if (GO_CMD_PATTERN.test(rel)) return true;
  return false;
}

function isSkippableFile(name: string): boolean {
  return (
    LOCKFILE_NAMES.has(name.toLowerCase()) ||
    BINARY_EXTENSIONS.has(path.extname(name).toLowerCase())
  );
}

async function collectEntry(
  dir: string,
  rel: string,
  item: import('node:fs').Dirent,
  entries: string[],
): Promise<void> {
  const relPath = rel ? `${rel}/${item.name}` : item.name;
  if (item.isDirectory()) {
    if (!SKIP_DIRS.has(item.name)) {
      await walk(path.join(dir, item.name), relPath, entries);
    }
    return;
  }
  if (!item.isFile()) return;
  if (isSkippableFile(item.name)) return;
  entries.push(relPath);
}

async function walk(dir: string, rel: string, entries: string[]): Promise<void> {
  if (entries.length >= MAX_TREE_ENTRIES) return;
  const items = await fs.readdir(dir, { withFileTypes: true });
  items.sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (entries.length >= MAX_TREE_ENTRIES) return;
    await collectEntry(dir, rel, item, entries);
  }
}

export async function buildFileTree(workdir: string): Promise<string[]> {
  const entries: string[] = [];
  await walk(workdir, '', entries);
  return entries;
}

export function truncateKeyFile(content: string, budget: number): string {
  if (content.length <= budget) return content;
  return `${content.slice(0, budget)}\n… [truncated]`;
}

// ---------------------------------------------------------------------------
// AGENTS.md: the repo's own root file wins; otherwise an injected template
// (a kind 'agents_md' Skill chosen for the repository) fills the gap.
// ---------------------------------------------------------------------------

// Pure decision: which AGENTS.md content goes into the context. Blank
// content counts as missing on both sides.
export function selectAgentsMd(
  rootAgentsMd: string | null,
  template: string | null,
): string | null {
  if (rootAgentsMd && rootAgentsMd.trim().length > 0) return rootAgentsMd;
  if (template && template.trim().length > 0) return template;
  return null;
}

async function readRootAgentsMd(workdir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workdir, 'AGENTS.md'), 'utf8');
  } catch {
    return null;
  }
}

// Prepends the AGENTS.md section (root file or template) and records it in
// the manifest. Returns the chars consumed so the caller can budget the
// remaining key files.
async function prependAgentsMdSection(
  workdir: string,
  template: string | null,
  sections: string[],
  files: RepoContextFile[],
): Promise<number> {
  const root = await readRootAgentsMd(workdir);
  const selected = selectAgentsMd(root, template);
  if (selected === null) return 0;
  const fromRoot = root !== null && root.trim().length > 0;
  const content = truncateKeyFile(selected, MAX_AGENTS_MD_CHARS);
  const label = fromRoot ? 'AGENTS.md' : 'AGENTS.md (template)';
  sections.push(`## ${label}\n\`\`\`\n${content}\n\`\`\``);
  files.push({ path: label, chars: content.length });
  return content.length;
}

interface KeyFileSection {
  text: string;
  consumed: number;
}

// One entry of the manifest buildRepoContext returns alongside the text:
// which key files were actually included and how many chars each contributed.
export interface RepoContextFile {
  path: string;
  chars: number;
}

export interface RepoContext {
  text: string;
  files: RepoContextFile[];
}

async function readKeyFileSection(
  workdir: string,
  rel: string,
  remaining: number,
): Promise<KeyFileSection | null> {
  const abs = path.join(workdir, rel);
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_KEY_FILE_BYTES) return null;
    const raw = await fs.readFile(abs, 'utf8');
    const content = truncateKeyFile(raw, Math.min(MAX_KEY_FILE_CHARS, remaining));
    return { text: `## File: ${rel}\n\`\`\`\n${content}\n\`\`\``, consumed: content.length };
  } catch {
    // Unreadable or non-UTF8 file — skip it.
    return null;
  }
}

async function appendKeyFileSections(
  workdir: string,
  tree: string[],
  sections: string[],
  files: RepoContextFile[],
  budgetChars: number,
): Promise<void> {
  let remaining = budgetChars;
  for (const rel of tree) {
    if (remaining <= 0) return;
    if (!isKeyFile(rel)) continue;
    const section = await readKeyFileSection(workdir, rel, remaining);
    if (!section) continue;
    sections.push(section.text);
    files.push({ path: rel, chars: section.consumed });
    remaining -= section.consumed;
  }
}

export async function buildRepoContext(
  workdir: string,
  contextWindowTokens: number,
  agentsMdTemplate: string | null = null,
): Promise<RepoContext> {
  const tree = await buildFileTree(workdir);
  const treeText = tree.slice(0, MAX_TREE_ENTRIES).join('\n').slice(0, MAX_TREE_CHARS);
  const sections: string[] = [];
  const files: RepoContextFile[] = [];
  const agentsMdChars = await prependAgentsMdSection(workdir, agentsMdTemplate, sections, files);
  sections.push(`## File tree (${tree.length} files)\n${treeText}`);
  await appendKeyFileSections(
    workdir,
    tree,
    sections,
    files,
    contextBudgetChars(contextWindowTokens) - treeText.length - agentsMdChars,
  );
  return { text: sections.join('\n\n'), files };
}
