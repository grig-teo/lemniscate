import {
  listPrReviewComments,
  listPullRequests,
  pullRequestState,
  type ListedPullRequest,
  type PrState,
} from './pull-requests.js';
import { enqueueAddressReview, getAgentTasksQueue } from './proposal-scheduler.js';
import { applyTaskPrStateSafe, type TaskWithConnection } from './pr-merged-handler.js';
import { recoverStuckReviews } from './stuck-review.js';
import { reviewFeedbackSkipReason } from './review-feedback.js';
import { config } from '../config.js';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { sleep } from './utils.js';

// Repeatable 'pr-state-sync' job. A task whose PR is merged manually on the
// git host (or merged while the worker was down) would sit in awaiting_review
// forever — this polls the provider and marks those tasks done.
//
// Polling is batched per repository: one listPullRequests call resolves all
// of a repo's awaiting branches instead of one state call per task, so the
// provider API burn scales with repos, not with open PRs.
//
// PR-state application (status flip + notify + workdir cleanup) lives in
// pr-merged-handler.ts so both this poller and the inbound webhook receiver
// share the same code path (AGENTS.md §6 — single home).

// Re-exported so existing importers (worker, tests) keep a single import path.
export { taskStatusForPrState } from './pr-merged-handler.js';
// Stuck-review recovery lives in stuck-review.ts (300-line guard); re-exported
// for worker.ts and tests that import it from this module.
export { recoverStuckReviews } from './stuck-review.js';

// Configurable (config.PR_STATE_SYNC_INTERVAL_MS, default 5 minutes) so the
// e2e stack can shorten the cadence and observe the poll fallback.
const PR_STATE_SYNC_SCHEDULER_ID = 'pr-state-sync';
// One hung provider must not stall the whole sweep — a repo whose list call
// times out falls back to per-branch checks.
const REPO_LIST_TIMEOUT_MS = 30 * 1000;
// Small random gap between repos so a burst of list calls does not land in
// the same second (provider rate-limit friendliness).
const INTER_REPO_JITTER_MS = 250;

// Registers the single global repeatable 'pr-state-sync' job. Called at
// worker startup so the schedule survives Redis flushes and redeploys.
export async function registerPrStateSyncSchedule(): Promise<void> {
  await getAgentTasksQueue().upsertJobScheduler(
    PR_STATE_SYNC_SCHEDULER_ID,
    { every: config.PR_STATE_SYNC_INTERVAL_MS },
    { name: 'pr-state-sync', data: {} },
  );
}

// Per-branch fallback: one provider lookup for this task's PR. Provider
// failures are logged and skipped — the next run retries.
async function syncTaskPrState(task: TaskWithConnection): Promise<boolean> {
  if (!task.branchName) return false;
  let state: PrState;
  try {
    state = await pullRequestState(task.repository.connection, {
      repoFullName: task.repository.fullName,
      headBranch: task.branchName,
      baseBranch: task.repository.defaultBranch,
    });
  } catch (err) {
    logger.warn({ taskId: task.id, err }, 'pr-state-sync: check failed');
    return false;
  }
  return applyTaskPrStateSafe(task, state, 'pr-state-sync');
}

// Batched listing with a timeout guard so one hung provider cannot stall
// the whole sweep — the caller falls back to per-branch checks on failure.
async function listRepoPullRequests(task: TaskWithConnection): Promise<ListedPullRequest[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      listPullRequests(task.repository.connection, task.repository.fullName),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`listing timed out after ${REPO_LIST_TIMEOUT_MS}ms`)),
          REPO_LIST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function findPrForTask(
  pulls: ListedPullRequest[],
  task: TaskWithConnection,
): ListedPullRequest | undefined {
  return pulls.find(
    (pr) => pr.headBranch === task.branchName && pr.baseBranch === task.repository.defaultBranch,
  );
}

// Resolves all awaiting-review tasks of one repository with a single list
// call. Branches missing from the list (listing failed, paginated past the
// cap, or the PR is too old) fall back to the per-branch check.
async function syncRepositoryTasks(tasks: TaskWithConnection[]): Promise<number> {
  const first = tasks[0];
  if (!first) return 0;
  let pulls: ListedPullRequest[] | null = null;
  try {
    pulls = await listRepoPullRequests(first);
  } catch (err) {
    logger.warn({ repository: first.repository.fullName, err }, 'pr-state-sync: list failed');
  }
  let marked = 0;
  for (const task of tasks) {
    const pr = pulls ? findPrForTask(pulls, task) : undefined;
    const resolved = pr ? await applyTaskPrStateSafe(task, pr.state, 'pr-state-sync') : await syncTaskPrState(task);
    if (resolved) marked += 1;
  }
  return marked;
}

function groupByRepository(tasks: TaskWithConnection[]): TaskWithConnection[][] {
  const groups = new Map<string, TaskWithConnection[]>();
  for (const task of tasks) {
    const group = groups.get(task.repositoryId) ?? [];
    group.push(task);
    groups.set(task.repositoryId, group);
  }
  return [...groups.values()];
}

// Job: pr-state-sync — moves awaiting_review tasks to done when their PR was
// merged on the git host, or to closed when it was closed without merging.
// Archived tasks are included: the PR state is a fact about the task and the
// archived list should show it truthfully.
export async function syncMergedPullRequests(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      status: { in: ['awaiting_review', 'reviewing_code', 'waiting_ci'] },
      prUrl: { not: null },
      branchName: { not: null },
      repository: { connection: { disconnectedAt: null } },
    },
    include: { repository: { include: { connection: true } } },
  });
  let marked = 0;
  let repoIndex = 0;
  for (const repoTasks of groupByRepository(tasks)) {
    if (repoIndex > 0) await sleep(Math.random() * INTER_REPO_JITTER_MS);
    repoIndex += 1;
    marked += await syncRepositoryTasks(repoTasks);
  }
  if (tasks.length > 0) {
    logger.info({ marked, total: tasks.length }, 'pr-state-sync: resolved awaiting-review tasks');
  }
  await recoverStuckReviews();
  await pollReviewFeedback();
}

// ---------------------------------------------------------------------------
// Human review-feedback poll (fallback for hosts without webhooks)
// ---------------------------------------------------------------------------

// A reviewer leaving more than this many comments between two ticks gets
// the newest ones addressed; the rest stays for a human (token-spend cap).
const MAX_FEEDBACK_COMMENTS_PER_TASK = 5;

// Hosts without configured webhooks never deliver pr_review_comment — this
// poll (same 5-min cadence as the state sync) fetches the PR's review
// comments via the provider API and enqueues address-review for the
// actionable ones. Per-task failures are logged and skipped; the next tick
// retries. Providers without a review-comment API report an empty list.
export async function pollReviewFeedback(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      status: { in: ['awaiting_review', 'reviewing_code', 'waiting_ci'] },
      archivedAt: null,
      branchName: { not: null },
      repository: { autoAddressReview: true, connection: { disconnectedAt: null } },
    },
    include: { repository: { include: { connection: true } } },
  });
  let enqueued = 0;
  for (const task of tasks) {
    enqueued += await pollTaskReviewFeedback(task).catch((err: unknown) => {
      logger.warn({ taskId: task.id, err }, 'pr-state-sync: review feedback poll failed');
      return 0;
    });
  }
  if (enqueued > 0) {
    logger.info({ enqueued, total: tasks.length }, 'pr-state-sync: enqueued address-review jobs');
  }
}

// Fetches the PR's comments and enqueues address-review for each actionable
// one (not self-authored, not already addressed). Returns the enqueue count.
async function pollTaskReviewFeedback(task: TaskWithConnection): Promise<number> {
  // Defensive re-check: the query filters on these, but a flag flipped
  // between query and use must not slip a job through.
  if (!task.branchName || !task.repository.autoAddressReview) return 0;
  const comments = await listPrReviewComments(task.repository.connection, {
    repoFullName: task.repository.fullName,
    headBranch: task.branchName,
    baseBranch: task.repository.defaultBranch,
  });
  const actionable = comments.filter(
    (comment) =>
      reviewFeedbackSkipReason({
        taskStatus: task.status,
        branchName: task.branchName,
        lastAddressedReviewId: task.lastAddressedReviewId,
        autoAddressReview: task.repository.autoAddressReview,
        connectionUsername: task.repository.connection.username,
        comment,
      }) === null,
  );
  let enqueued = 0;
  for (const comment of actionable.slice(-MAX_FEEDBACK_COMMENTS_PER_TASK)) {
    await enqueueAddressReview(task.id, comment);
    enqueued += 1;
  }
  return enqueued;
}
