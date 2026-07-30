import {
  closePullRequest,
  openPullRequest,
  withGitlemRepo,
  type GitlemPullRequest,
} from './gitlem-store.js';
import { ProviderError } from './git-providers.js';
import type {
  ListedPullRequest,
  MergePullRequestResult,
  OpenPullRequestInput,
  OpenPullRequestResult,
  PrChecksStatus,
  PrConnectionInput,
  ProviderPrApi,
  PullRequestRefInput,
} from './pr-shared.js';

// gitlem pull-request operations (the internal minimal git host). Same
// ProviderPrApi contract as the REST clients, but backed by the gitlem
// document store (lib/gitlem-store.ts) instead of HTTP — the host lives in
// this same process. Dispatched from pull-requests.ts providerPrApi().

function gitlemWebUrl(input: { repoFullName: string }, number: number): string {
  return `/gitlem/repos/${input.repoFullName}/pulls/${number}`;
}

function gitlemPrUrl(input: { repoFullName: string }, number?: number): string {
  return number ? gitlemWebUrl(input, number) : `/gitlem/repos/${input.repoFullName}`;
}

// Finds the open PR for the head branch (numbers are not stored on tasks).
async function gitlemLookupPullNumber(input: PullRequestRefInput): Promise<number> {
  const { doc } = await withGitlemRepo(input.repoFullName);
  const match = doc.pullRequests.find(
    (pr) => pr.headBranch === input.headBranch && pr.baseBranch === input.baseBranch,
  );
  if (!match) {
    throw new ProviderError(
      `gitlem: no pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  if (match.state !== 'open') {
    throw new ProviderError(
      `gitlem: pull request #${match.number} is ${match.state}, not open`,
    );
  }
  return match.number;
}

async function gitlemOpenPullRequest(input: OpenPullRequestInput): Promise<OpenPullRequestResult> {
  const { doc, save } = await withGitlemRepo(input.repoFullName);
  const existing = doc.pullRequests.find(
    (pr) =>
      pr.headBranch === input.headBranch &&
      pr.baseBranch === input.baseBranch &&
      pr.state === 'open',
  );
  if (existing) return { prUrl: gitlemWebUrl(input, existing.number) };
  const next = await openPullRequest(doc, input);
  await save(next);
  return { prUrl: gitlemWebUrl(input, next.pullRequests.at(-1)?.number ?? 0) };
}

async function gitlemMergePullRequest(input: PullRequestRefInput): Promise<MergePullRequestResult> {
  const number = await gitlemLookupPullNumber(input);
  const { doc, save } = await withGitlemRepo(input.repoFullName);
  await save(closePullRequest(doc, number, 'merged'));
  return { merged: true, prUrl: gitlemWebUrl(input, number) };
}

// Minimal diff format for the agent review path: one header per changed
// file followed by its full content (no base snapshots are kept in the
// document store, so line-level diffs are not reconstructible).
async function gitlemPullRequestDiff(input: PullRequestRefInput): Promise<string> {
  const { doc } = await withGitlemRepo(input.repoFullName);
  const head = doc.branches.find((b) => b.name === input.headBranch);
  if (!head) throw new ProviderError(`gitlem: branch ${input.headBranch} not found`);
  return head.files
    .map((f) => `diff --git a/${f.path} b/${f.path}\n--- /dev/null\n+++ b/${f.path}\n${f.content}`)
    .join('\n');
}

async function gitlemPullRequestState(
  input: PullRequestRefInput,
): Promise<'open' | 'merged' | 'closed'> {
  const { doc } = await withGitlemRepo(input.repoFullName);
  const match = doc.pullRequests.find(
    (pr) => pr.headBranch === input.headBranch && pr.baseBranch === input.baseBranch,
  );
  if (!match) throw new ProviderError(`gitlem: pull request not found`);
  return match.state;
}

async function gitlemListPullRequests(repoFullName: string): Promise<ListedPullRequest[]> {
  const { doc } = await withGitlemRepo(repoFullName);
  return doc.pullRequests.map((pr) => ({
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    state: pr.state,
  }));
}

async function gitlemClosePullRequest(input: PullRequestRefInput): Promise<void> {
  const number = await gitlemLookupPullNumber(input);
  const { doc, save } = await withGitlemRepo(input.repoFullName);
  await save(closePullRequest(doc, number, 'closed'));
}

async function gitlemDeleteBranch(_repoFullName: string, _branch: string): Promise<void> {
  // The document store has no branch deletion (merge keeps the head branch);
  // treat as a no-op so the merge-gate cleanup path works for gitlem.
}

// Merge-gate semantics: the latest CI run on the head branch is the check
// suite; a queued run counts as pending (never blocks as failing).
async function gitlemChecksStatus(input: PullRequestRefInput): Promise<PrChecksStatus> {
  const { doc } = await withGitlemRepo(input.repoFullName);
  const run = [...doc.ciRuns].reverse().find((r) => r.branch === input.headBranch);
  if (!run) return { supported: true, green: true, state: 'green' };
  if (run.status === 'queued') return { supported: true, green: false, state: 'pending' };
  return run.status === 'success'
    ? { supported: true, green: true, state: 'green' }
    : { supported: true, green: false, state: 'failing' };
}

export function gitlemPrApi(_connection: PrConnectionInput): ProviderPrApi {
  return {
    open: (input) => gitlemOpenPullRequest(input),
    merge: (input) => gitlemMergePullRequest(input),
    diff: (input) => gitlemPullRequestDiff(input),
    state: (input) => gitlemPullRequestState(input),
    list: (repoFullName) => gitlemListPullRequests(repoFullName),
    close: (input) => gitlemClosePullRequest(input),
    deleteBranch: (repoFullName, branch) => gitlemDeleteBranch(repoFullName, branch),
    checks: (input) => gitlemChecksStatus(input),
  };
}
