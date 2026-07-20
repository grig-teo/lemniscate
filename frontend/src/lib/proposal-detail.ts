import type { StartTaskBody, TaskImage } from '@/lib/hooks';

// Pure helpers for the pending-proposal detail view (console/ProposalDetail):
// the markdown-append rule for the attach row, and the minimal
// POST /api/tasks/:id/start body (changed fields only). The pending-proposal
// predicate lives in lib/repo-tasks.ts (isPendingProposal).

/** Append attached markdown content to the prompt, separated by a blank line. */
export function appendMarkdownToPrompt(prompt: string, content: string): string {
  const trimmedContent = content.trim();
  if (!prompt.trim()) return trimmedContent;
  return `${prompt}\n\n${trimmedContent}`;
}

export type { StartTaskBody } from '@/lib/hooks';

/**
 * Body for POST /api/tasks/:id/start: title and prompt only when edited,
 * images whenever any are attached. Empty when nothing changed.
 */
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
