import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mutateGitlemRepoDoc } from './gitlem-doc-access.js';
import { logger } from './logger.js';
import { GITLEM_MAX_FILE_CHARS, replaceBranchTree, type GitlemFile } from './gitlem-store.js';

// Push ingestion for gitlem: a `git push` against a materialized bare repo
// (receive-pack now enabled in gitlem-clone.ts) writes objects into that bare
// repo. This module reads the pushed branch trees back out and writes them
// into the repo's JSON `doc` — the durable source of truth — so the next
// materialization reflects the push. Triggered by the bare repo's
// post-receive hook.
//
// The doc stays authoritative: a push defines the FULL state of each pushed
// branch (replaceBranchTree), and PRs/CI/counters survive. Binary files and
// files over the per-file cap are skipped (the doc is a text store).

const execFileAsync = promisify(execFile);

// Bound doc growth: a real-world lemniscate repo rarely has thousands of
// files on one branch, and the doc column is not the place for a giant tree.
const MAX_FILES_PER_BRANCH = 500;

function isBinaryContent(content: Buffer): boolean {
  // The standard heuristic git itself uses (in git's buffer_is_binary): a
  // NUL byte anywhere in the first 8KB marks the file binary.
  return content.subarray(0, 8192).includes(0);
}

/** Run one git command against the bare repo and return its stdout (Buffer). */
async function gitBuffer(args: string[], bareDir: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: bareDir,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'buffer',
  });
  return stdout;
}

/** Run one git command against the bare repo and return its stdout (string). */
async function gitText(args: string[], bareDir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: bareDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

interface LsTreeEntry {
  path: string;
  type: string;
}

// `git ls-tree -r -z` emits one entry per record: "<mode> <type> <sha>\t<path>"
// separated by NUL bytes. Only blob entries are files; trees/submodules are
// skipped.
async function listBranchFiles(bareDir: string, ref: string): Promise<LsTreeEntry[]> {
  const raw = await gitText(['ls-tree', '-r', '-z', ref], bareDir);
  const entries: LsTreeEntry[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    // meta = [mode, type, sha]
    if (meta[1] !== 'blob' || !path) continue;
    entries.push({ path, type: 'blob' });
  }
  return entries;
}

async function readBlob(bareDir: string, ref: string, path: string): Promise<Buffer | null> {
  try {
    return await gitBuffer(['show', `${ref}:${path}`], bareDir);
  } catch (err) {
    // A race (branch deleted between ls-tree and show) or an encoding oddity:
    // skip the file rather than failing the whole ingest.
    logger.warn({ path, err }, 'gitlem-ingest: could not read blob, skipping');
    return null;
  }
}

// Materialize one branch's blob tree into the doc's file model. Binary blobs
// and oversized files are skipped; the per-branch file cap bounds doc growth.
async function collectBranchTree(
  bareDir: string,
  ref: string,
): Promise<{ files: GitlemFile[]; skipped: number }> {
  const entries = await listBranchFiles(bareDir, ref);
  const files: GitlemFile[] = [];
  let skipped = 0;
  for (const entry of entries.slice(0, MAX_FILES_PER_BRANCH)) {
    const blob = await readBlob(bareDir, ref, entry.path);
    if (!blob) {
      skipped += 1;
      continue;
    }
    if (isBinaryContent(blob)) {
      skipped += 1;
      continue;
    }
    const content = blob.toString('utf8');
    if (content.length > GITLEM_MAX_FILE_CHARS) {
      skipped += 1;
      continue;
    }
    files.push({ path: entry.path, content });
  }
  skipped += Math.max(0, entries.length - MAX_FILES_PER_BRANCH);
  return { files, skipped };
}

// All refs/heads/* present in the bare repo: a push may add or update one or
// more branches, and the full doc rebuild keeps the doc in sync with whatever
// refs now exist. Returned as [[branchName, ref], ...].
async function listBranchRefs(bareDir: string): Promise<Array<[string, string]>> {
  const raw = await gitText(['for-each-ref', '--format=%(refname:short) %(refname)', 'refs/heads'], bareDir);
  const refs: Array<[string, string]> = [];
  for (const line of raw.split('\n')) {
    const parts = line.split(' ');
    if (parts.length === 2 && parts[0] && parts[1]) refs.push([parts[0], parts[1]]);
  }
  return refs;
}

/**
 * Read every branch tree out of the bare repo and write it back into the
 * repo's JSON doc (single read-modify-write transaction). Called by the
 * post-receive hook after a successful push. Resolves with the number of
 * branches ingested and files skipped (binary/oversized).
 */
export async function ingestPushedRefs(
  repoId: string,
  bareDir: string,
): Promise<{ branches: number; skipped: number }> {
  const refs = await listBranchRefs(bareDir);
  let totalSkipped = 0;
  // Collect each branch's tree first (git reads outside the transaction), then
  // apply them all in one doc transaction.
  const trees: Array<{ branch: string; files: GitlemFile[] }> = [];
  for (const [branch, ref] of refs) {
    const { files, skipped } = await collectBranchTree(bareDir, ref);
    totalSkipped += skipped;
    trees.push({ branch, files });
  }
  const outcome = await mutateGitlemRepoDoc(repoId, (doc) => {
    for (const { branch, files } of trees) {
      replaceBranchTree(doc, branch, files);
    }
    return { branches: trees.length };
  });
  if ('error' in outcome) {
    logger.error({ repoId, err: outcome.error }, 'gitlem-ingest: doc write failed');
    return { branches: 0, skipped: totalSkipped };
  }
  return { branches: outcome.branches, skipped: totalSkipped };
}

// Re-exported for the hook entrypoint to call without a circular import.
export { invalidateGitlemCloneCache } from './gitlem-clone.js';
