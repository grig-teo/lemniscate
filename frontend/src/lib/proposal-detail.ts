import type { StartTaskBody, TaskImage } from '@/lib/hooks';
import type { AgentsMdAssignment } from '@/lib/create-repo';
import type { AgentsMdInitial } from '@/lib/library-attachments';

// Pure helpers for the pending-task detail view (console/ProposalDetail):
// the markdown-append rule for the attach row, request bodies for
// POST /api/tasks/:id/start and PATCH /api/tasks/:id, and the prefill
// mapping from a stored task to the LibraryAttachments editor state.

/** Append attached markdown content to the prompt, separated by a blank line. */
export function appendMarkdownToPrompt(prompt: string, content: string): string {
  const trimmedContent = content.trim();
  if (!prompt.trim()) return trimmedContent;
  return `${prompt}\n\n${trimmedContent}`;
}

export type { StartTaskBody } from '@/lib/hooks';

/** Library selections sent with a task edit (start or save). */
export interface TaskEditSelections {
  skillSlugs: string[];
  mcpServerSlugs: string[];
  agentsMdFiles: AgentsMdAssignment[];
}

/** StartTaskBody plus the library attachment fields (API naming: `skills`). */
export type TaskEditBody = StartTaskBody & {
  skills?: string[];
  mcpServerSlugs?: string[];
  agentsMdFiles?: AgentsMdAssignment[];
};

/**
 * Body for a task edit (start or PATCH): title/prompt only when edited,
 * images whenever any are attached, and the full library selection state —
 * start/save from the detail editor always sends the complete selections,
 * so no field-level diffing is needed.
 */
export function buildTaskEditBody(args: {
  task: { title: string; prompt: string };
  title: string;
  prompt: string;
  images: TaskImage[];
  selections: TaskEditSelections;
}): TaskEditBody {
  const body: TaskEditBody = {};
  if (args.title !== args.task.title) body.title = args.title;
  if (args.prompt !== args.task.prompt) body.prompt = args.prompt;
  if (args.images.length > 0) body.images = args.images;
  body.skills = args.selections.skillSlugs;
  body.mcpServerSlugs = args.selections.mcpServerSlugs;
  body.agentsMdFiles = args.selections.agentsMdFiles;
  return body;
}

/** @deprecated Use buildTaskEditBody — kept for the existing proposal tests. */
export function buildStartTaskBody(args: {
  task: { title: string; prompt: string };
  title: string;
  prompt: string;
  images: TaskImage[];
}): StartTaskBody {
  const body: StartTaskBody = {};
  if (args.title !== args.task.title) body.title = args.title;
  if (args.prompt !== args.task.prompt) body.prompt = args.prompt;
  if (args.images.length > 0) body.images = args.images;
  return body;
}

// ---------------------------------------------------------------------------
// Prefill: stored task → LibraryAttachments initial state.
// ---------------------------------------------------------------------------

/** Stored skills (Json slug array) + the skill list → slug → name map. */
export function taskSkillSelections(
  stored: unknown,
  allSkills: { slug: string; name: string }[],
): Map<string, string> {
  if (!Array.isArray(stored)) return new Map();
  const names = new Map(allSkills.map((skill) => [skill.slug, skill.name]));
  const selections = new Map<string, string>();
  for (const slug of stored) {
    if (typeof slug === 'string') selections.set(slug, names.get(slug) ?? slug);
  }
  return selections;
}

/** Stored MCP map ({ slug: config }) → slug → slug selection map. */
export function taskMcpSelections(stored: unknown): Map<string, string> {
  if (typeof stored !== 'object' || stored === null) return new Map();
  return new Map(Object.keys(stored).map((slug) => [slug, slug]));
}

/** Stored per-folder AGENTS.md files → editor assignments (content = saved file). */
export function taskAgentsMdInitial(stored: unknown): AgentsMdInitial[] {
  if (!Array.isArray(stored)) return [];
  const initial: AgentsMdInitial[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { folder, content } = entry as { folder?: unknown; content?: unknown };
    if (typeof folder !== 'string' || typeof content !== 'string') continue;
    initial.push({
      folder,
      value: {
        label: '(saved file)',
        upload: { name: '(saved file)', size: content.length, content, truncated: false },
      },
    });
  }
  return initial;
}
