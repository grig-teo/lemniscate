import { prisma } from './prisma.js';
import { commitAndPush, git, logEvent, type GitAuth } from './agent-git.js';
import type { LlmRuntime, TaskWithRepo } from './agent-runtime.js';

// Publishing a run's changes to the git host: the task-branch push (fetch +
// --force-with-lease so a rerun over a same-named branch isn't rejected) and
// the changed-paths diff recorded for the run-targets endpoint. Extracted
// from agent-run.ts so that module stays under the AGENTS.md §2 size limit.

// Pushes the task branch. A rerun regenerates a slug from the task title, so
// the remote often still holds the previous run's commits under the same
// branch name and a plain push is rejected as non-fast-forward. Fetch the
// remote tip into a tracking ref (best-effort: a first run has no remote
// branch yet) so the push can lease against it, then --force-with-lease
// overwrites the stale branch cleanly — the same pattern as merge-gate-
// rebase's force-push (AGENTS.md §6 SSoT). --force-with-lease still creates
// a brand-new branch when no remote ref exists to lease against, so first
// runs are unaffected.
export async function pushTaskBranch(
  task: TaskWithRepo,
  rt: LlmRuntime,
  workdir: string,
  branchName: string,
  summary: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await fetchRemoteBranch(task, workdir, branchName, secrets, auth);
  await commitAndPush(
    task,
    rt,
    workdir,
    summary,
    ['push', '-u', '--force-with-lease', 'origin', branchName],
    secrets,
    auth,
  );
  await logEvent(task.id, `pushed branch ${branchName}`);
}

// Fetches the remote task branch into a tracking ref so the push lease
// reflects the remote's actual tip (a fresh shallow clone has none). Swallow
// the failure: a first run has no remote branch to fetch.
async function fetchRemoteBranch(
  task: TaskWithRepo,
  workdir: string,
  branchName: string,
  secrets: string[],
  auth: GitAuth,
): Promise<void> {
  await git(
    ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`],
    { cwd: workdir, secrets, taskId: task.id, auth },
  ).catch(() => {});
}

// Persists the repo-relative paths the task branch changed (feeds the
// run-targets endpoint). Fail-soft: a failed diff is logged to the task
// console and changedPaths stays null, so the endpoint falls back to the
// repository platform.
export async function recordChangedPaths(
  task: TaskWithRepo,
  workdir: string,
): Promise<void> {
  try {
    const out = await git(
      ['diff', '--name-only', `${task.repository.defaultBranch}...HEAD`],
      { cwd: workdir, taskId: task.id },
    );
    const changedPaths = out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    await prisma.task.update({ where: { id: task.id }, data: { changedPaths } });
  } catch (err) {
    await logEvent(task.id, `could not record changed paths: ${(err as Error).message}`).catch(
      () => {},
    );
  }
}
