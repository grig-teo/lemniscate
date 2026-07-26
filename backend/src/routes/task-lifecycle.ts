import type { Prisma } from '@prisma/client';
import { attachmentsData } from '../lib/task-attachments.js';
import {
  findUnknownMcpServerSlugs,
  findUnknownSkillSlugs,
  isAgentsMdSkill,
  resolveAgentsMdFileContents,
  resolveMcpServerConfigs,
} from '../lib/task-skills.js';
import type { PatchBody, StartBody } from './task-schemas.js';

// Task lifecycle rules: status predicates, ownership scoping, and the update
// builders shared by the task handlers. Pure (or prisma-via-lib only) so the
// rules stay unit-testable without a Fastify instance.

export const CANCELLABLE_STATUSES = ['pending', 'queued', 'running'] as const;

// Archive eligibility for POST /tasks/:id/archive: anything except running
// and queued (about to run) tasks can be archived.
const UNARCHIVABLE_STATUSES = ['running', 'queued'] as const;

export function isArchivable(status: string): boolean {
  return !(UNARCHIVABLE_STATUSES as readonly string[]).includes(status);
}

// GET /tasks archived filter: archived tasks are hidden by default; with
// ?archived=true ONLY the archived ones are returned.
export function archivedTasksWhere(archived?: boolean) {
  return archived ? { archivedAt: { not: null } } : { archivedAt: null };
}

// Ownership scope: task → repository → connection → user.
export function ownedTaskWhere(userId: string, taskId: string) {
  return { id: taskId, repository: { connection: { userId } } };
}

// Initial status of a freshly created prompt task: queued (enqueued right
// away) by default; `later: true` parks it as pending for click-to-start.
export function initialTaskStatus(later: boolean | undefined): 'queued' | 'pending' {
  return later ? 'pending' : 'queued';
}

// Start eligibility for POST /tasks/:id/start: returns why a task cannot be
// started, or null when it can. Pending proposals and saved-for-later
// prompts are click-to-run.
const STARTABLE_KINDS = ['proposal', 'prompt'];

export function startBlocker(task: { kind: string; status: string }): string | null {
  if (!STARTABLE_KINDS.includes(task.kind)) {
    return 'only proposal and prompt tasks can be started';
  }
  if (task.status !== 'pending') return `task is ${task.status}, not pending`;
  return null;
}

// Update applied when a pending task is started: always queues the task; any
// edited fields (title/prompt/attachments/library selections) are written in
// the same update. Undefined attachment fields leave the column untouched;
// an explicit empty array clears it.
export function buildStartUpdate(body: StartBody) {
  return {
    status: 'queued' as const,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    ...attachmentsData(body.images),
    ...(body.skills !== undefined ? { skills: body.skills } : {}),
  };
}

// Rerun eligibility for POST /tasks/:id/rerun: only failed tasks (including
// user-cancelled ones, which are stored as failed) can be run again.
export function rerunBlocker(task: { status: string }): string | null {
  if (task.status !== 'failed') return `task is ${task.status}, not failed`;
  return null;
}

// Rerunning resets the run state: re-queued from scratch with a fresh
// branch, no leftover error or PR link.
export function buildRerunUpdate() {
  return { status: 'queued' as const, error: null, branchName: null, prUrl: null };
}

// Async part of the attachment update: slugs are resolved to the stored
// configs/contents so a later library edit can't retroactively change the run.
export async function resolveAttachmentUpdate(body: PatchBody, userId?: string) {
  return {
    ...(body.mcpServerSlugs !== undefined
      ? { mcpServers: (await resolveMcpServerConfigs(body.mcpServerSlugs, userId)) as Prisma.InputJsonValue }
      : {}),
    ...(body.agentsMdFiles !== undefined
      ? { agentsMdFiles: (await resolveAgentsMdFileContents(body.agentsMdFiles, userId)) as Prisma.InputJsonValue }
      : {}),
  };
}

// Validates the attachment fields of a start/PATCH body; returns the 400
// message or null. Unknown slugs are named in the error.
export async function attachmentValidationError(
  body: PatchBody,
  userId?: string,
): Promise<string | null> {
  if (body.skills) {
    const unknown = await findUnknownSkillSlugs(body.skills, userId);
    if (unknown.length > 0) return `Unknown skill slug(s): ${unknown.join(', ')}`;
  }
  if (body.mcpServerSlugs) {
    const unknown = await findUnknownMcpServerSlugs(body.mcpServerSlugs, userId);
    if (unknown.length > 0) return `Unknown MCP server slug(s): ${unknown.join(', ')}`;
  }
  for (const entry of body.agentsMdFiles ?? []) {
    if (entry.skillId && !(await isAgentsMdSkill(entry.skillId, userId))) {
      return `agentsMdFiles skillId does not reference an AGENTS.md skill: ${entry.skillId}`;
    }
  }
  return null;
}

// SSE is served only when the client explicitly asks for it (EventSource// always sends Accept: text/event-stream). Everything else — fetch's
// default included — gets the JSON history; otherwise a plain fetch hangs
// on the open stream forever ("Loading task history…" bug).
export function wantsSse(accept: string | undefined): boolean {
  return accept?.includes('text/event-stream') ?? false;
}
