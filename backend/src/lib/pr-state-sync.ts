import {
  listPullRequests,
  pullRequestState,
  type ListedPullRequest,
  type PrState,
} from './pull-requests.js';
import { enqueueReviewTask, getAgentTasksQueue } from './proposal-scheduler.js';
import { applyTaskPrStateSafe, type TaskWithConnection } from './pr-merged-handler.js';
import { logEvent } from './agent-git.js';
import { prisma } from './prisma.js';
import { errorMessage, sleep } from './utils.js';

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

// Re-exported so existing importers (tests) keep a single import path.
export { taskStatusForPrState } from './pr-merged-handler.js';

const PR_STATE_SYNC_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
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
    { every: PR_STATE_SYNC_INTERVAL_MS },
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
    console.warn(`pr-state-sync: check failed for task ${task.id}: ${errorMessage(err)}`);
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
    console.warn(
      `pr-state-sync: list failed for repo ${first.repository.fullName}: ${errorMessage(err)}`,
    );
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
      status: 'awaiting_review',
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
    console.log(`pr-state-sync: resolved ${marked}/${tasks.length} awaiting-review task(s)`);
  }
  await recoverStuckReviews();
}

// ---------------------------------------------------------------------------
// Stuck-review recovery
// ---------------------------------------------------------------------------

const MAX_REVIEW_RECOVERIES = 3;
const REVIEW_RECOVERY_LOG = 'recovery: re-enqueued PR review after a failed review job';

// A review that concluded (approve / changes requested / checks gate) ends
// with a distinct log line; a review whose job exhausted its BullMQ attempts
// ends with an 'error:' line. Only the latter is stuck.
async function isReviewStuck(taskId: string): Promise<boolean> {
  const recoveries = await prisma.taskEvent.count({
    where: { taskId, kind: 'log', payload: { path: ['line'], equals: REVIEW_RECOVERY_LOG } },
  });
  if (recoveries >= MAX_REVIEW_RECOVERIES) return false;
  const lastLog = await prisma.taskEvent.findFirst({
    where: { taskId, kind: 'log' },
    orderBy: { createdAt: 'desc' },
    select: { payload: true },
  });
  const line = (lastLog?.payload as { line?: unknown } | null)?.line;
  return typeof line === 'string' && line.startsWith('error:');
}

// Re-enqueues review for awaiting_review tasks whose review job died for good
// (e.g. repeated LLM timeouts). Bounded per task so a persistently failing
// endpoint cannot burn tokens in an infinite review loop. The BullMQ jobId
// dedupes against a review job that is still waiting/active/retrying.
export async function recoverStuckReviews(): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: {
      status: 'awaiting_review',
      archivedAt: null,
      branchName: { not: null },
      repository: { autoReviewPr: true, connection: { disconnectedAt: null } },
    },
    select: { id: true },
  });
  let recovered = 0;
  for (const task of tasks) {
    if (!(await isReviewStuck(task.id))) continue;
    await logEvent(task.id, REVIEW_RECOVERY_LOG);
    await enqueueReviewTask(task.id);
    recovered += 1;
  }
  if (recovered > 0) {
    console.log(`pr-state-sync: re-enqueued review for ${recovered} stuck task(s)`);
  }
}
