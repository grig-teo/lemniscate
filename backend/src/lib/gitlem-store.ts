// Document model for gitlem repositories (the internal minimal git host).
//
// One GitlemRepository row holds the whole repository state as a JSON
// document (the `doc` column): branches, files, pull requests, CI runs.
// This module is the single home for that document's shape and its pure
// operations (AGENTS.md §6) — routes and the provider client never mutate
// the document inline, they call these helpers inside a prisma $transaction.

export const GITLEM_DEFAULT_BRANCH = 'main';
export const GITLEM_MAX_FILE_CHARS = 200_000;

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

function ensureBranch(doc: GitlemRepoDoc, name: string): GitlemBranch {
  const existing = findBranch(doc, name);
  if (existing) return existing;
  const created: GitlemBranch = { name, files: [] };
  doc.branches.push(created);
  return created;
}

/** Create a branch from another branch's file tree (or empty). */
export function addBranch(doc: GitlemRepoDoc, name: string, from: string | null): boolean {
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
  return run;
}
