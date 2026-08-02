import type { Prisma } from '@prisma/client';
import { attachmentsData } from '../lib/task-attachments.js';
import { prisma } from '../lib/prisma.js';
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

// Archive eligibility for POST /tasks/:id/archive: anything except running,
// queued (about to run), and reviewing_code (agent actively reviewing) tasks.
const UNARCHIVABLE_STATUSES = ['running', 'queued', 'reviewing_code'] as const;

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

/**
 * Single source of truth for "the user owns this LLM config and it is enabled"
 * (AGENTS.md §6) — used by PATCH /tasks/:id (the pending-task model override,
 * the proposal/prompt detail's bottom dropdown) and POST /tasks/:id/model (the
 * mid-run model switch). Returns the minimal row needed for display and the
 * stored update, or null when the config does not exist for this user.
 */
export async function findOwnedLlmConfig(
  userId: string,
  configId: string,
): Promise<{ id: string; name: string; model: string } | null> {
  return prisma.llmConfig.findFirst({
    where: { id: configId, userId, enabled: true },
    select: { id: true, name: true, model: true },
  });
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

// Rerun eligibility for POST /tasks/:id/rerun. Failed (incl. user-cancelled,
// stored as failed) and closed (PR closed without merge) tasks can rerun.
// queued/running are also accepted so an orphaned task — whose BullMQ job died
// without flipping the status (e.g. a worker kill mid-run, leaving it stranded
// with no live job) — can be recovered via the rerun button. enqueueRunTask
// uses a stable jobId (run-task-<id>) so a duplicate enqueue while one is
// already waiting/active is collapsed by BullMQ, and runTask no-ops on a task
// whose status has already moved on (guard in agent-run.ts).
const RERUNNABLE_STATUSES = ['failed', 'closed', 'queued', 'running'] as const;

export function rerunBlocker(task: { status: string }): string | null {
  if (!(RERUNNABLE_STATUSES as readonly string[]).includes(task.status)) {
    return `task is ${task.status}, not rerunnable`;
  }
  return null;
}

// Backlog-return eligibility for POST /tasks/:id/backlog (the Kanban drag-back
// to "Prompts / Proposals"): a task can return to the backlog (pending) only
// from an in-flight, non-terminal state. Terminal states are not resurrectable
// into the backlog, and awaiting_plan_approval is a distinct approval flow.
const BACKLOG_RETURNABLE_STATUSES = [
  'pending',
  'queued',
  'running',
  'awaiting_review',
  'reviewing_code',
  'waiting_ci',
] as const;

export function backlogBlocker(task: { status: string }): string | null {
  if (!(BACKLOG_RETURNABLE_STATUSES as readonly string[]).includes(task.status)) {
    return `task is ${task.status}, not in an in-flight state`;
  }
  return null;
}

// Mid-run model-switch eligibility for POST /tasks/:id/model: a queued run
// resolves the new config id at start; a running / reviewing_code run picks
// it up between LLM calls (applyPendingModelSwitch in agent-runtime.ts).
const MODEL_SWITCHABLE_STATUSES = ['queued', 'running', 'reviewing_code'] as const;

export function modelSwitchBlocker(task: { status: string }): string | null {
  if (!(MODEL_SWITCHABLE_STATUSES as readonly string[]).includes(task.status)) {
    return `task is ${task.status} — the model can only be switched while queued, running, or reviewing code`;
  }
  return null;
}

// Close-PR eligibility for POST /tasks/:id/close-pr: only awaiting_review
// (or reviewing_code / waiting_ci) tasks (an open PR exists on the git host)
// with a branchName can be closed and have their branch deleted. The provider
// calls happen in the handler.
export function closePrBlocker(task: { status: string; branchName: string | null }): string | null {
  if (task.status !== 'awaiting_review' && task.status !== 'reviewing_code' && task.status !== 'waiting_ci') {
    return `task is ${task.status}, not awaiting_review`;
  }
  if (!task.branchName) {
    return 'task has no branch to close';
  }
  return null;
}

// Manual review eligibility for POST /tasks/:id/review: only awaiting_review
// tasks (an open PR exists) with a branch can be reviewed. reviewing_code is
// accepted so a re-trigger while a review is already running is a no-op idempotent
// re-enqueue (BullMQ jobId dedupes the same attempt); waiting_ci is accepted
// because the PR already exists — the user just wants it re-reviewed now.
export function reviewBlocker(task: { status: string; branchName: string | null }): string | null {
  if (task.status !== 'awaiting_review' && task.status !== 'reviewing_code' && task.status !== 'waiting_ci') {
    return `task is ${task.status}, not awaiting_review`;
  }
  if (!task.branchName) {
    return 'task has no branch to review';
  }
  return null;
}

// Manual merge eligibility for POST /tasks/:id/merge: only awaiting_review
// (or reviewing_code / waiting_ci) tasks with a branch can be merged — a
// waiting_ci task has an open PR the user may want to merge without waiting
// for the checks. 'done' tasks (already merged) and terminal states are
// rejected — the PR no longer exists to merge.
export function mergeBlocker(task: { status: string; branchName: string | null }): string | null {
  if (task.status !== 'awaiting_review' && task.status !== 'reviewing_code' && task.status !== 'waiting_ci') {
    return `task is ${task.status}, not awaiting_review`;
  }
  if (!task.branchName) {
    return 'task has no branch to merge';
  }
  return null;
}

// Rerunning resets the run state: re-queued from scratch with a fresh
// branch, no leftover error code/message or PR link.
export function buildRerunUpdate() {
  return {
    status: 'queued' as const,
    error: null,
    errorCode: null,
    branchName: null,
    prUrl: null,
  };
}

// Pause eligibility for POST /tasks/:id/pause: only an in-flight task the
// executor is actively working (queued/about to run, running, or
// reviewing_code) can be put on hold — terminal/parked states have no live
// run to pause. The executor loop detects the flip on its next turn
// boundary / cancel-poll tick and exits cleanly (TaskPausedError).
const PAUSABLE_STATUSES = ['queued', 'running', 'reviewing_code'] as const;

export function pauseBlocker(task: { status: string }): string | null {
  if (!(PAUSABLE_STATUSES as readonly string[]).includes(task.status)) {
    return `task is ${task.status}, not pausable`;
  }
  return null;
}

// Resume is the inverse of pause: only a task that was paused can be
// resumed — anything else has no paused run to replay.
export function resumeBlocker(task: { status: string }): string | null {
  if (task.status !== 'paused') return `task is ${task.status}, not paused`;
  return null;
}

// Resume re-queues the task but keeps the branch and PR link intact — the
// workdir is preserved across pause, so the resumed run continues from the
// saved transcript, not from scratch (contrast with buildRerunUpdate).
export function buildResumeUpdate() {
  return { status: 'queued' as const };
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
