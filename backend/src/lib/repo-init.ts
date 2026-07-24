import type { CreateFileInput } from './git-providers.js';
import { errorMessage } from './utils.js';

// Initialization of freshly created repositories: which files to seed
// (README.md, per-folder AGENTS.md, .agents/skills/<slug>/SKILL.md,
// .mcp.json) and the best-effort loop that commits them through the
// provider client. Used by POST /connections/:id/repositories.

export interface RepoInitSkillFile {
  slug: string;
  name: string;
  description: string;
  content: string;
}

export interface RepoInitAgentsMdFile {
  // '/' or a nested folder like 'src/api' (leading/trailing slashes tolerated).
  folder: string;
  content: string;
}

export interface RepoInitPlanInput {
  repoName: string;
  readme: boolean;
  // AGENTS.md files per folder; empty content entries are skipped.
  agentsMdFiles?: RepoInitAgentsMdFile[];
  // Selected skills materialized under .agents/skills/<slug>/SKILL.md.
  skillFiles?: RepoInitSkillFile[];
  // MCP server slug → config fragment; written as root .mcp.json.
  mcpServers?: Record<string, unknown>;
}

export interface RepoInitFile {
  path: string;
  content: string;
  message: string;
}

// Normalizes a folder selection to a repo-relative prefix ('' = root).
// Throws on traversal attempts — the value becomes a git path.
export function sanitizeFolder(folder: string): string {
  const trimmed = folder.replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed === '.') return '';
  if (trimmed.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Invalid folder: ${folder}`);
  }
  return trimmed;
}

// SKILL.md with the hermes-style YAML frontmatter the seed parser produces.
function skillFileContent(skill: RepoInitSkillFile): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.content}`;
}

function mcpJsonContent(servers: Record<string, unknown>): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

// Attachment files written into the cloned workdir before a task run:
// `.mcp.json` from the task's stored MCP map and per-folder AGENTS.md files.
export function buildTaskAttachmentFiles(task: {
  mcpServers?: unknown;
  agentsMdFiles?: unknown;
}): RepoInitFile[] {
  const files: RepoInitFile[] = [];
  if (
    typeof task.mcpServers === 'object' &&
    task.mcpServers !== null &&
    Object.keys(task.mcpServers).length > 0
  ) {
    files.push({
      path: '.mcp.json',
      content: mcpJsonContent(task.mcpServers as Record<string, unknown>),
      message: 'Add .mcp.json',
    });
  }
  if (Array.isArray(task.agentsMdFiles)) {
    for (const entry of task.agentsMdFiles) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { folder, content } = entry as { folder?: unknown; content?: unknown };
      if (typeof folder !== 'string' || typeof content !== 'string' || content === '') continue;
      const prefix = sanitizeFolder(folder);
      files.push({
        path: prefix === '' ? 'AGENTS.md' : `${prefix}/AGENTS.md`,
        content,
        message: prefix === '' ? 'Add AGENTS.md' : `Add ${prefix}/AGENTS.md`,
      });
    }
  }
  return files;
}

// Pure decision: which files the new repo gets. README first so the very
// first commit of an empty repo is the README.
export function buildRepoInitFiles(input: RepoInitPlanInput): RepoInitFile[] {
  const files: RepoInitFile[] = [];
  if (input.readme) {
    files.push({
      path: 'README.md',
      content: `# ${input.repoName}\n\nCreated with Lemniscate.\n`,
      message: 'Add README.md',
    });
  }
  for (const agentsMd of input.agentsMdFiles ?? []) {
    if (!agentsMd.content) continue;
    const prefix = sanitizeFolder(agentsMd.folder);
    files.push({
      path: prefix === '' ? 'AGENTS.md' : `${prefix}/AGENTS.md`,
      content: agentsMd.content,
      message: prefix === '' ? 'Add AGENTS.md' : `Add ${prefix}/AGENTS.md`,
    });
  }
  for (const skill of input.skillFiles ?? []) {
    files.push({
      path: `.agents/skills/${skill.slug}/SKILL.md`,
      content: skillFileContent(skill),
      message: `Add skill ${skill.slug}`,
    });
  }
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    files.push({ path: '.mcp.json', content: mcpJsonContent(input.mcpServers), message: 'Add .mcp.json' });
  }
  return files;
}

export interface RepoInitResult {
  readme: boolean;
  agentsMd: boolean;
  warnings: string[];
}

// Minimal client shape so the loop is testable without a full provider.
interface CreateFileClient {
  createFile(input: CreateFileInput): Promise<void>;
}

function flagFor(path: string): 'readme' | 'agentsMd' | null {
  if (path === 'README.md') return 'readme';
  if (path === 'AGENTS.md') return 'agentsMd';
  return null;
}

// Best-effort per file: a provider failure (e.g. contents-API quirks on
// empty repos) is caught, reported as a warning, and never aborts the rest.
export async function initializeRepoFiles(
  client: CreateFileClient,
  repoFullName: string,
  branch: string,
  files: RepoInitFile[],
): Promise<RepoInitResult> {
  const result: RepoInitResult = { readme: false, agentsMd: false, warnings: [] };
  for (const file of files) {
    try {
      await client.createFile({
        repoFullName,
        path: file.path,
        content: file.content,
        message: file.message,
        branch,
      });
      const flag = flagFor(file.path);
      if (flag) result[flag] = true;
    } catch (err) {
      result.warnings.push(`Failed to create ${file.path}: ${errorMessage(err)}`);
    }
  }
  return result;
}
