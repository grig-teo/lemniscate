import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  git,
  logEvent,
  sanitizeRelativePath,
  cloneRepository,
} from './agent-git.js';
import type { GateContext } from './merge-gate-context.js';
import { hasConflictMarkers } from './conflict-resolve.js';
import { buildAgentConflictPrompt } from './pr-review.js';
import { publishTaskEvent } from './task-events.js';

// Rebase machinery for the merge-gate job: staleness checkout, the rebase
// loop, and the lemcore conflict resolver.

// Paths with unresolved rebase/merge conflicts in the workdir.
async function conflictedPaths(workdir: string): Promise<string[]> {
  const output = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: workdir });
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Full clone of the base branch (a shallow one lacks the common ancestor a
// rebase needs) plus the head branch, with the remote-tracking ref updated
// so the later --force-with-lease push leases against the state we saw.
// Returns true when the base has commits the head lacks — the branch is
// stale and must be rebased before merging.
export async function prepareMergeCheckout(ctx: GateContext): Promise<boolean> {
  const { task, headBranch, workdir, cloneUrl, secrets, auth } = ctx;
  await cloneRepository(workdir, cloneUrl, task.repository.defaultBranch, secrets, {
    shallow: false,
    auth,
  });
  await git(
    ['fetch', 'origin', `+refs/heads/${headBranch}:refs/remotes/origin/${headBranch}`],
    { cwd: workdir, secrets, auth },
  );
  try {
    // Base tip already in the head's history → branch is up to date.
    await git(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], { cwd: workdir });
    return false;
  } catch {
    return true;
  }
}

// One rebase step (start or --continue): returns the conflicted paths, []
// when the step completed the rebase. A failure with NO conflicted paths is
// a genuine rebase error and is rethrown.
async function tryRebaseStep(workdir: string, args: string[]): Promise<string[]> {
  try {
    await git(args, { cwd: workdir });
    return [];
  } catch (err) {
    const conflicted = await conflictedPaths(workdir);
    if (conflicted.length === 0) throw err;
    return conflicted;
  }
}

// Safety net: each --continue advances one commit, so real rebases need far
// fewer rounds; a loop here means the resolver is stuck.
const MAX_REBASE_ROUNDS = 50;
const REBASE_BRANCH = 'lemniscate-rebase';

// Rebases the head branch onto the local base checkout, letting `resolve`
// rewrite each round's conflicted files (git add happens inside it), then
// force-pushes the linear branch back over the PR head.
async function runRebaseLoop(
  ctx: GateContext,
  resolve: (conflicted: string[]) => Promise<void>,
): Promise<void> {
  const { task, headBranch, workdir, secrets, auth } = ctx;
  await git(['checkout', '-b', REBASE_BRANCH, 'FETCH_HEAD'], { cwd: workdir });
  let conflicted = await tryRebaseStep(workdir, ['rebase', task.repository.defaultBranch]);
  for (let rounds = 0; conflicted.length > 0; rounds += 1) {
    if (rounds >= MAX_REBASE_ROUNDS) {
      throw new Error(`rebase conflict resolution did not converge after ${rounds} rounds`);
    }
    await resolve(conflicted);
    // core.editor=true: reuse the original commit message non-interactively.
    conflicted = await tryRebaseStep(workdir, ['-c', 'core.editor=true', 'rebase', '--continue']);
  }
  await git(['push', '--force-with-lease', 'origin', `HEAD:${headBranch}`], {
    cwd: workdir,
    secrets,
    auth,
  });
}

// Rebases the head branch onto the base (checkout already prepared by
// prepareMergeCheckout); lemcore rewrites each round's conflicted files and
// the resolved files are staged after marker verification.
export async function rebaseHeadBranchViaLemcore(ctx: GateContext): Promise<void> {
  const { task, rt, headBranch, workdir, secrets } = ctx;
  const { runLemcoreTask } = await import('./lemcore/run.js');
  await runRebaseLoop(ctx, async (conflicted) => {
    await logEvent(
      task.id,
      `resolving ${conflicted.length} conflicted file(s) with the lemcore agent`,
    );
    await runLemcoreTask({
      taskId: task.id,
      task,
      workdir,
      rt,
      secrets,
      resume: false,
      promptOverride: buildAgentConflictPrompt({
        baseBranch: task.repository.defaultBranch,
        headBranch,
        conflictedPaths: conflicted,
        systemPromptExtra: rt.cfg.systemPromptExtra,
      }),
    });
    await stageResolvedConflicts(ctx, conflicted, 'lemcore');
  });
}

async function stageResolvedConflicts(
  ctx: GateContext,
  conflicted: string[],
  agentLabel: string,
): Promise<void> {
  const { task, workdir } = ctx;
  for (const rel of conflicted) {
    const content = await fs.readFile(path.join(workdir, sanitizeRelativePath(rel)), 'utf8');
    if (hasConflictMarkers(content)) {
      throw new Error(`${agentLabel} left conflict markers in ${rel}`);
    }
    await git(['add', '--', rel], { cwd: workdir });
    await publishTaskEvent(task.id, 'diff', { path: rel, action: 'conflict-resolved' });
    await logEvent(task.id, `resolved conflict in ${rel}`);
  }
}
