import type { CreateFileInput } from './git-providers.js';
import { errorMessage } from './utils.js';

// Initialization of freshly created repositories: which files to seed
// (README.md, AGENTS.md) and the best-effort loop that commits them through
// the provider client. Used by POST /connections/:id/repositories.

export interface RepoInitPlanInput {
  repoName: string;
  readme: boolean;
  // Resolved AGENTS.md text (uploaded content or template skill content);
  // undefined/empty means no AGENTS.md file.
  agentsMdContent?: string | null;
}

export interface RepoInitFile {
  path: string;
  content: string;
  message: string;
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
  if (input.agentsMdContent) {
    files.push({
      path: 'AGENTS.md',
      content: input.agentsMdContent,
      message: 'Add AGENTS.md',
    });
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
