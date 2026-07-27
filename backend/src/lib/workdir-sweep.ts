// Orphaned-workdir sweep planning (worker boot). Extracted from agent-git.ts.

// A workdir is worth keeping only while its owning task is queued/running:
// run-task uses the bare taskId, review-pr uses `review-<taskId>-<attempt>`.
// proposals-*/folders-* workdirs belong to stateless jobs and are always
// safe to sweep at boot.
function isActiveWorkdir(dirName: string, activeTaskIds: ReadonlySet<string>): boolean {
  if (activeTaskIds.has(dirName)) return true;
  const reviewMatch = /^review-(.+)-\d+$/.exec(dirName);
  return reviewMatch !== null && activeTaskIds.has(reviewMatch[1] ?? '');
}

// Directories under AGENT_WORKDIR that no queued/running task owns — stale
// leftovers (with readable .git dirs) after a SIGKILLed worker.
export function planWorkdirSweep(
  dirNames: string[],
  activeTaskIds: ReadonlySet<string>,
): string[] {
  return dirNames.filter((name) => !isActiveWorkdir(name, activeTaskIds));
}
