import {
  closePullRequest,
  findBranch,
  findOpenPullRequest,
  openPullRequest,
  parseGitlemDoc,
  type GitlemPullRequest,
  type GitlemRepoDoc,
} from './gitlem-store.js';
import { ProviderError } from './git-providers.js';
import { prisma } from './prisma.js';
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

// Resolves '<username>/<name>' to the owner's repository row; the username
// namespace comes from the full name (repos are per-account on gitlem).
async function repoForFullName(repoFullName: string): Promise<{ id: string; doc: string }> {
  const [username, name] = repoFullName.split('/');
  const owner = username
    ? await prisma.gitlemUser.findUnique({ where: { username } })
    : null;
  const repo = owner
    ? await prisma.gitlemRepository.findUnique({
        where: { ownerId_name: { ownerId: owner.id, name: name ?? '' } },
      })
    : null;
  if (!repo) throw new ProviderError(`gitlem: repository ${repoFullName} not found`, 404);
  return repo;
}

/** Read the repo document (repoForFullName + parse in one step). */
async function readGitlemDoc(repoFullName: string): Promise<GitlemRepoDoc> {
  const repo = await repoForFullName(repoFullName);
  return parseGitlemDoc(repo.doc);
}

/** Read-modify-write the repo document inside a transaction. */
async function mutateGitlemDoc(
  repoFullName: string,
  mutate: (doc: GitlemRepoDoc) => void,
): Promise<GitlemRepoDoc> {
  const repo = await repoForFullName(repoFullName);
  const doc = await prisma.$transaction(async (tx) => {
    const current = await tx.gitlemRepository.findUniqueOrThrow({ where: { id: repo.id } });
    const parsed = parseGitlemDoc(current.doc);
    mutate(parsed);
    await tx.gitlemRepository.update({
      where: { id: repo.id },
      data: { doc: JSON.stringify(parsed) },
    });
    return parsed;
  });
  return doc;
}

// Finds the open PR for the head branch (numbers are not stored on tasks).
async function gitlemLookupPullNumber(input: PullRequestRefInput): Promise<number> {
  const doc = await readGitlemDoc(input.repoFullName);
  const match = findOpenPullRequest(doc, input.headBranch, input.baseBranch);
  if (!match) {
    throw new ProviderError(
      `gitlem: no open pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return match.number;
}

async function gitlemOpenPullRequest(input: OpenPullRequestInput): Promise<OpenPullRequestResult> {
  const doc = await mutateGitlemDoc(input.repoFullName, (parsed) => {
    if (findOpenPullRequest(parsed, input.headBranch, input.baseBranch)) return;
    openPullRequest(parsed, {
      title: input.title,
      body: input.body,
      head: input.headBranch,
      base: input.baseBranch,
    });
  });
  const pr = findOpenPullRequest(doc, input.headBranch, input.baseBranch);
  return { prUrl: gitlemWebUrl(input, pr?.number ?? 0) };
}

async function gitlemCloseByState(
  input: PullRequestRefInput,
  state: 'closed' | 'merged',
): Promise<number> {
  const number = await gitlemLookupPullNumber(input);
  await mutateGitlemDoc(input.repoFullName, (doc) => {
    if (!closePullRequest(doc, number, state)) {
      throw new ProviderError(`gitlem: pull request #${number} not found`, 404);
    }
  });
  return number;
}

async function gitlemMergePullRequest(input: PullRequestRefInput): Promise<MergePullRequestResult> {
  const number = await gitlemCloseByState(input, 'merged');
  return { merged: true, prUrl: gitlemWebUrl(input, number) };
}

async function gitlemClosePullRequest(input: PullRequestRefInput): Promise<void> {
  await gitlemCloseByState(input, 'closed');
}

// Minimal diff format for the agent review path: one header per changed
// file followed by its full content (no base snapshots are kept in the
// document store, so line-level diffs are not reconstructible).
async function gitlemPullRequestDiff(input: PullRequestRefInput): Promise<string> {
  const doc = await readGitlemDoc(input.repoFullName);
  const head = findBranch(doc, input.headBranch);
  if (!head) throw new ProviderError(`gitlem: branch ${input.headBranch} not found`);
  return head.files
    .map((f) => `diff --git a/${f.path} b/${f.path}\n--- /dev/null\n+++ b/${f.path}\n${f.content}`)
    .join('\n');
}

function toListedPr(pr: GitlemPullRequest): ListedPullRequest {
  return { headBranch: pr.head, baseBranch: pr.base, state: pr.state };
}

async function gitlemPullRequestState(
  input: PullRequestRefInput,
): Promise<'open' | 'merged' | 'closed'> {
  const doc = await readGitlemDoc(input.repoFullName);
  const match = doc.prs.find(
    (pr) => pr.head === input.headBranch && pr.base === input.baseBranch,
  );
  if (!match) throw new ProviderError(`gitlem: pull request not found`);
  return match.state;
}

async function gitlemListPullRequests(repoFullName: string): Promise<ListedPullRequest[]> {
  const doc = await readGitlemDoc(repoFullName);
  return doc.prs.map(toListedPr);
}

async function gitlemDeleteBranch(_repoFullName: string, _branch: string): Promise<void> {
  // The document store has no branch deletion (merge keeps the head branch);
  // treat as a no-op so the merge-gate cleanup path works for gitlem.
}

// Merge-gate semantics: the latest CI run on the head branch is the check
// suite; a queued run counts as pending (never blocks as failing).
async function gitlemChecksStatus(input: PullRequestRefInput): Promise<PrChecksStatus> {
  const doc = await readGitlemDoc(input.repoFullName);
  const run = doc.ciRuns.find((r) => r.branch === input.headBranch);
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
