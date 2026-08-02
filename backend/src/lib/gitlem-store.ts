// Document model for gitlem repositories (the internal minimal git host).
//
// One GitlemRepository row holds the whole repository state as a JSON
// document (the `doc` column): branches, files, pull requests, CI runs.
// This module is the single home for that document's shape and its pure
// operations. The prisma-backed access helpers (ownership resolution + the
// read-modify-write doc transaction) live in gitlem-doc-access.ts — routes
// and the provider clients never mutate the document inline (AGENTS.md §6).

export const GITLEM_DEFAULT_BRANCH = 'main';
export const GITLEM_MAX_FILE_CHARS = 200_000;
/** Stored prs/ciRuns are capped at this many latest entries — the JSON doc is unbounded otherwise. */
export const GITLEM_MAX_HISTORY = 50;

export interface GitlemFile {
  path: string;
  content: string;
}

export interface GitlemBranch {
  name: string;
  files: GitlemFile[];
}

export interface GitlemCiRun {
  id: string;
  branch: string;
  status: 'queued' | 'running' | 'success' | 'failed';
  log: string;
  createdAt: string;
}

export interface GitlemPullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
}

export interface GitlemRepoDoc {
  branches: GitlemBranch[];
  prs: GitlemPullRequest[];
  ciRuns: GitlemCiRun[];
  nextPrNumber: number;
  nextRunId: number;
}

export function emptyGitlemDoc(): GitlemRepoDoc {
  return { branches: [], prs: [], ciRuns: [], nextPrNumber: 1, nextRunId: 1 };
}

/**
 * Fresh repository seeded with a README on the default branch, so the repo
 * detail view (README / branches / CI) works immediately after creation,
 * before anything is pushed.
 */
export function seedGitlemDoc(name: string): GitlemRepoDoc {
  const doc = emptyGitlemDoc();
  upsertFile(doc, GITLEM_DEFAULT_BRANCH, 'README.md', `# ${name}\n`);
  return doc;
}

export function parseGitlemDoc(doc: string): GitlemRepoDoc {
  try {
    const parsed = JSON.parse(doc) as Partial<GitlemRepoDoc>;
    return {
      branches: Array.isArray(parsed.branches) ? parsed.branches : [],
      prs: Array.isArray(parsed.prs) ? parsed.prs : [],
      ciRuns: Array.isArray(parsed.ciRuns) ? parsed.ciRuns : [],
      nextPrNumber: parsed.nextPrNumber ?? 1,
      nextRunId: parsed.nextRunId ?? 1,
    };
  } catch {
    return emptyGitlemDoc();
  }
}

export function findBranch(doc: GitlemRepoDoc, name: string): GitlemBranch | undefined {
  return doc.branches.find((branch) => branch.name === name);
}

// git-refname safety subset (git check-ref-format rejects these): branch
// names reach git argv during materialization, where a leading '-' would be
// option injection even with execFile, and '..'/~^:?*/space/control chars
// are not valid refname components.
const BRANCH_UNSAFE_CHARS = /[\x00-\x20\x7f~^:?*[\]\\]/;

export function isValidGitlemBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false;
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) return false;
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{') || name === '@') {
    return false;
  }
  return !BRANCH_UNSAFE_CHARS.test(name);
}

function ensureBranch(doc: GitlemRepoDoc, name: string): GitlemBranch {
  const existing = findBranch(doc, name);
  if (existing) return existing;
  const created: GitlemBranch = { name, files: [] };
  doc.branches.push(created);
  return created;
}

/** Create a branch from another branch's file tree (or empty). */
export function addBranch(doc: GitlemRepoDoc, name: string, from: string | null): boolean {
  if (!isValidGitlemBranchName(name)) return false;
  if (findBranch(doc, name)) return false;
  const source = from ? findBranch(doc, from) : undefined;
  doc.branches.push({
    name,
    files: (source?.files ?? []).map((file) => ({ ...file })),
  });
  return true;
}

/** Upsert one file into a branch (creating the branch when missing). */
export function upsertFile(
  doc: GitlemRepoDoc,
  branchName: string,
  path: string,
  content: string,
): void {
  const branch = ensureBranch(doc, branchName);
  const existing = branch.files.find((file) => file.path === path);
  if (existing) {
    existing.content = content;
  } else {
    branch.files.push({ path, content });
  }
}

export function readFile(
  doc: GitlemRepoDoc,
  branchName: string,
  path: string,
): GitlemFile | undefined {
  return findBranch(doc, branchName)?.files.find((file) => file.path === path);
}

/**
 * Replace one branch's whole file tree with `files`. A git push defines the
 * full authoritative state of the pushed branch, so files absent from `files`
 * are removed (unlike upsertFile, which only adds/updates). Creates the branch
 * when missing. PRs, CI runs, and the PR/run counters are left untouched — a
 * push never rewrites repo history metadata. (Single home for this op so the
 * ingest path doesn't mutate the doc inline — AGENTS.md §6.)
 */
export function replaceBranchTree(
  doc: GitlemRepoDoc,
  branchName: string,
  files: GitlemFile[],
): void {
  const branch = ensureBranch(doc, branchName);
  branch.files = files.map((file) => ({ path: file.path, content: file.content }));
}

export function openPullRequest(
  doc: GitlemRepoDoc,
  input: { title: string; body: string; head: string; base: string },
): GitlemPullRequest {
  const pr: GitlemPullRequest = {
    number: doc.nextPrNumber,
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    state: 'open',
    createdAt: new Date().toISOString(),
  };
  doc.nextPrNumber += 1;
  doc.prs.push(pr);
  // The JSON doc is unbounded otherwise — keep only the latest entries.
  doc.prs.splice(0, Math.max(0, doc.prs.length - GITLEM_MAX_HISTORY));
  return pr;
}

/** The open PR matching a head/base pair (numbers are not stored on tasks). */
export function findOpenPullRequest(
  doc: GitlemRepoDoc,
  head: string,
  base: string,
): GitlemPullRequest | undefined {
  return doc.prs.find((pr) => pr.head === head && pr.base === base && pr.state === 'open');
}

/** The PR to report for a head/base pair: the open one, else the latest by number. */
export function findPullRequest(
  doc: GitlemRepoDoc,
  head: string,
  base: string,
): GitlemPullRequest | undefined {
  const matches = doc.prs.filter((pr) => pr.head === head && pr.base === base);
  return (
    matches.find((pr) => pr.state === 'open') ??
    matches.sort((a, b) => b.number - a.number)[0]
  );
}

/** Set a PR's final state; returns false when the number is unknown. */
export function closePullRequest(
  doc: GitlemRepoDoc,
  number: number,
  state: 'closed' | 'merged',
): boolean {
  const pr = doc.prs.find((candidate) => candidate.number === number);
  if (!pr) return false;
  pr.state = state;
  return true;
}

/**
 * Merge a PR: apply the head branch's file tree onto the base branch (head
 * wins per path; base-only files are kept) and mark the PR merged. Returns
 * false when the number is unknown.
 */
export function mergePullRequest(doc: GitlemRepoDoc, number: number): boolean {
  const pr = doc.prs.find((candidate) => candidate.number === number);
  if (!pr) return false;
  const head = findBranch(doc, pr.head);
  for (const file of head?.files ?? []) {
    upsertFile(doc, pr.base, file.path, file.content);
  }
  pr.state = 'merged';
  return true;
}

/** Deterministic pseudo CI/CD run: succeeds when the branch has any file. */
export function startCiRun(doc: GitlemRepoDoc, branchName: string): GitlemCiRun {
  const branch = findBranch(doc, branchName);
  const files = branch?.files ?? [];
  const success = files.length > 0;
  const log = [
    `$ gitlem ci run --branch ${branchName}`,
    'checkout: ok',
    `pipeline: build → test (${files.length} file(s) in tree)`,
    success ? 'build: ok' : 'build: failed (empty tree)',
    success ? 'test: ok' : 'test: skipped',
    success ? 'result: success' : 'result: failed',
  ].join('\n');
  const run: GitlemCiRun = {
    id: `run-${doc.nextRunId}`,
    branch: branchName,
    status: success ? 'success' : 'failed',
    log,
    createdAt: new Date().toISOString(),
  };
  doc.nextRunId += 1;
  doc.ciRuns.unshift(run);
  // The JSON doc is unbounded otherwise — keep only the latest entries.
  doc.ciRuns.length = Math.min(doc.ciRuns.length, GITLEM_MAX_HISTORY);
  return run;
}

export interface GitlemPrFileChange {
  path: string;
  status: 'added' | 'modified';
  headLines: number;
  baseLines: number;
}

function lineCount(content: string): number {
  return content === '' ? 0 : content.split('\n').length;
}

/**
 * File-level diff of a PR: head files whose content differs from base,
 * sorted by path. Merge semantics (head wins per path, base-only files are
 * kept) mean deletions never apply, so only added/modified entries exist.
 * Returns null when the PR number is unknown.
 */
export function pullRequestChanges(doc: GitlemRepoDoc, number: number): GitlemPrFileChange[] | null {
  const pr = doc.prs.find((candidate) => candidate.number === number);
  if (!pr) return null;
  const baseFiles = new Map(
    (findBranch(doc, pr.base)?.files ?? []).map((file) => [file.path, file.content]),
  );
  return (findBranch(doc, pr.head)?.files ?? [])
    .filter((file) => baseFiles.get(file.path) !== file.content)
    .map((file) => ({
      path: file.path,
      status: (baseFiles.has(file.path) ? 'modified' : 'added') as 'added' | 'modified',
      headLines: lineCount(file.content),
      baseLines: lineCount(baseFiles.get(file.path) ?? ''),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
