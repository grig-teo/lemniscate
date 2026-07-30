import { promises as fs } from 'node:fs';
import path from 'node:path';
import { REVIEW_FILENAME, TRANSCRIPT_FILE } from './lemcore/loop-constants.js';

// Removes agent scratch files (review verdict JSON, transcript) from the
// workdir so they can never ride into a commit/PR — a lemcore review writes
// its verdict into the workdir root and one once reached a PR via git add -A.
export async function scrubAgentScratchFiles(workdir: string): Promise<void> {
  await fs.rm(path.join(workdir, REVIEW_FILENAME), { force: true });
  await fs.rm(path.join(workdir, TRANSCRIPT_FILE), { force: true });
}
