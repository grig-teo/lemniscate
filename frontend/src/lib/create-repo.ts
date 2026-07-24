/**
 * Pure helpers for the create-repository dialog: request-body assembly and
 * reading an uploaded custom AGENTS.md file (capped so a huge file cannot
 * blow up the create request).
 */

/** Maximum characters kept from an uploaded AGENTS.md file. */
export const AGENTS_MD_MAX_CHARS = 100_000;

/** One AGENTS.md assignment: `skillId` (template) or `content` (upload). */
export interface AgentsMdAssignment {
  folder: string;
  skillId?: string;
  content?: string;
}

/** Form state slice relevant to the POST body. */
export interface CreateRepoFormState {
  name: string;
  isPrivate: boolean;
  readme: boolean;
  skillSlugs: string[];
  mcpServerSlugs: string[];
  initPrompt: string;
  agentsMdFiles: AgentsMdAssignment[];
}

/** POST /api/connections/:id/repositories body; optional fields omitted when unset. */
export interface CreateRepoBody {
  name: string;
  private: boolean;
  readme: boolean;
  skillSlugs?: string[];
  mcpServerSlugs?: string[];
  initPrompt?: string;
  agentsMdFiles?: AgentsMdAssignment[];
}

/** `initialized` block of the 201 create-repository response. */
export interface CreateRepoInitialized {
  readme: boolean;
  agentsMd: boolean;
  warnings: string[];
}

/**
 * Assemble the POST body from form state, omitting unset optional fields.
 * An uploaded custom AGENTS.md (content) wins over a picked template
 * (skillId) within the same folder assignment.
 */
export function buildCreateRepoBody(state: CreateRepoFormState): CreateRepoBody {
  const body: CreateRepoBody = {
    name: state.name.trim(),
    private: state.isPrivate,
    readme: state.readme,
  };
  if (state.skillSlugs.length > 0) body.skillSlugs = state.skillSlugs;
  if (state.mcpServerSlugs.length > 0) body.mcpServerSlugs = state.mcpServerSlugs;
  if (state.initPrompt.trim()) body.initPrompt = state.initPrompt.trim();
  const agentsMdFiles = state.agentsMdFiles.filter((entry) => entry.skillId || entry.content);
  if (agentsMdFiles.length > 0) {
    body.agentsMdFiles = agentsMdFiles.map((entry) =>
      entry.content ? { folder: entry.folder, content: entry.content } : { folder: entry.folder, skillId: entry.skillId },
    );
  }
  return body;
}

export interface UploadedAgentsMd {
  name: string;
  size: number;
  content: string;
  truncated: boolean;
}

/** Minimal File shape needed here, so the helper stays testable without a DOM. */
interface TextFileLike {
  name: string;
  size: number;
  text: () => Promise<string>;
}

/** Read an uploaded .md/.txt file as text, capped at AGENTS_MD_MAX_CHARS. */
export async function readAgentsMdFile(file: TextFileLike): Promise<UploadedAgentsMd> {
  const text = await file.text();
  const truncated = text.length > AGENTS_MD_MAX_CHARS;
  return {
    name: file.name,
    size: file.size,
    content: truncated ? text.slice(0, AGENTS_MD_MAX_CHARS) : text,
    truncated,
  };
}

/** Human-readable file size for the upload line ("7 B", "2.0 KB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
