import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REVIEW_FILENAME, TRANSCRIPT_FILE } from './lemcore/loop-constants.js';

// Removes agent scratch files (review verdict JSON, transcript) and crash
// artifacts from the workdir so they can never ride into a commit/PR:
// - a lemcore review writes its verdict into the workdir root and one once
//   reached a PR via git add -A;
// - a test runner crashing in the workdir drops a multi-hundred-MB core dump
//   (frontend/core.12300, 655 MB on a real run) — git add -A swept it in and
//   GitHub rejected the push (100 MB limit), killing the task.
export async function scrubAgentScratchFiles(workdir: string): Promise<void> {
  await fs.rm(path.join(workdir, REVIEW_FILENAME), { force: true });
  await fs.rm(path.join(workdir, TRANSCRIPT_FILE), { force: true });
  await scrubCoreDumps(workdir);
}

// Deletes `core` / `core.<pid>` dumps anywhere under the workdir (depth-capped
// walk, node_modules/.git skipped — they never belong to the agent's changes
// and make the walk slow).
async function scrubCoreDumps(workdir: string): Promise<void> {
  const SKIP_DIRS = new Set(['node_modules', '.git']);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1);
        continue;
      }
      if (entry.isFile() && /^core(\.\d+)?$/.test(entry.name)) {
        await fs.rm(abs, { force: true });
      }
    }
  };
  await walk(workdir, 0);
}
