import { decrypt } from './crypto.js';
import {
  closePullRequest,
  findBranch,
  findOpenPullRequest,
  findOwnedGitlemRepo,
  findPullRequest,
  mergePullRequest,
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

// Resolves the connection's encrypted PAT to the gitlem account, failing
// closed (401) when there is no token or it matches no account. Every repo
// lookup below is then scoped to this account, so a token can never touch
// another account's same-named repo.
async function accountForConnection(
  connection: PrConnectionInput,
): Promise<{ id: string; username: string }> {
  if (!connection.accessTokenEnc) {
    throw new ProviderError('gitlem: connection has no access token', 401);
  }
  const apiToken = decrypt(connection.accessTokenEnc);
  const account = await prisma.gitlemUser.findUnique({ where: { apiToken } });
  if (!account) throw new ProviderError('gitlem: invalid access token', 401);
  return { id: account.id, username: account.username };
}

// Resolves '<username>/<name>' to the account's own repository row, failing
// closed (404) when the namespace is not the account's or the repo is absent.
async function ownedRepoFor(
  account: { id: string; username: string },
  repoFullName: string,
): Promise<{ id: string; doc: string }> {
  const repo = await findOwnedGitlemRepo(account, repoFullName);
  if (!repo) throw new ProviderError(`gitlem: repository ${repoFullName} not found`, 404);
  return repo;
}

/** Read the repo document (ownedRepoFor + parse in one step). */
async function readGitlemDoc(
  account: { id: string; username: string },
  repoFullName: string,
): Promise<GitlemRepoDoc> {
  const repo = await ownedRepoFor(account, repoFullName);
  return parseGitlemDoc(repo.doc);
}

/** Read-modify-write the repo document inside a transaction. */
async function mutateGitlemDoc(
  account: { id: string; username: string },
  repoFullName: string,
  mutate: (doc: GitlemRepoDoc) => void,
): Promise<GitlemRepoDoc> {
  const repo = await ownedRepoFor(account, repoFullName);
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

type GitlemAccount = { id: string; username: string };

// Finds the open PR for the head branch (numbers are not stored on tasks).
async function gitlemLookupPullNumber(
  account: GitlemAccount,
  input: PullRequestRefInput,
): Promise<number> {
  const doc = await readGitlemDoc(account, input.repoFullName);
  const match = findOpenPullRequest(doc, input.headBranch, input.baseBranch);
  if (!match) {
    throw new ProviderError(
      `gitlem: no open pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return match.number;
}

async function gitlemOpenPullRequest(
  account: GitlemAccount,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const doc = await mutateGitlemDoc(account, input.repoFullName, (parsed) => {
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

// Merges the open PR: applies the head branch's files onto the base branch
// and marks it merged (lib/gitlem-store.ts mergePullRequest is the single
// home for that file-tree merge — AGENTS.md §6).
async function gitlemMergePullRequest(
  account: GitlemAccount,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  const number = await gitlemLookupPullNumber(account, input);
  await mutateGitlemDoc(account, input.repoFullName, (doc) => {
    if (!mergePullRequest(doc, number)) {
      throw new ProviderError(`gitlem: pull request #${number} not found`, 404);
    }
  });
  return { merged: true, prUrl: gitlemWebUrl(input, number) };
}

async function gitlemClosePullRequest(account: GitlemAccount, input: PullRequestRefInput): Promise<void> {
  const number = await gitlemLookupPullNumber(account, input);
  await mutateGitlemDoc(account, input.repoFullName, (doc) => {
    if (!closePullRequest(doc, number, 'closed')) {
      throw new ProviderError(`gitlem: pull request #${number} not found`, 404);
    }
  });
}

// Minimal diff format for the agent review path: one header per changed
// file followed by its full content (no base snapshots are kept in the
// document store, so line-level diffs are not reconstructible).
async function gitlemPullRequestDiff(
  account: GitlemAccount,
  input: PullRequestRefInput,
): Promise<string> {
  const doc = await readGitlemDoc(account, input.repoFullName);
  const head = findBranch(doc, input.headBranch);
  if (!head) throw new ProviderError(`gitlem: branch ${input.headBranch} not found`);
  return head.files
    .map((f) => `diff --git a/${f.path} b/${f.path}\n--- /dev/null\n+++ b/${f.path}\n${f.content}`)
    .join('\n');
}

function toListedPr(pr: GitlemPullRequest): ListedPullRequest {
  return { headBranch: pr.head, baseBranch: pr.base, state: pr.state };
}

// Prefers the open PR for a head/base pair over any older closed/merged one
// (lib/gitlem-store.ts findPullRequest), so reopening a closed PR reports
// 'open' instead of the stale closed state.
async function gitlemPullRequestState(
  account: GitlemAccount,
  input: PullRequestRefInput,
): Promise<'open' | 'merged' | 'closed'> {
  const doc = await readGitlemDoc(account, input.repoFullName);
  const match = findPullRequest(doc, input.headBranch, input.baseBranch);
  if (!match) throw new ProviderError(`gitlem: pull request not found`);
  return match.state;
}

async function gitlemListPullRequests(
  account: GitlemAccount,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  const doc = await readGitlemDoc(account, repoFullName);
  return doc.prs.map(toListedPr);
}

async function gitlemDeleteBranch(_account: GitlemAccount, _repoFullName: string, _branch: string): Promise<void> {
  // The document store has no branch deletion (merge keeps the head branch);
  // treat as a no-op so the merge-gate cleanup path works for gitlem.
}

// Merge-gate semantics: the latest CI run on the head branch is the check
// suite; a queued OR running run counts as pending (never blocks as failing).
async function gitlemChecksStatus(
  account: GitlemAccount,
  input: PullRequestRefInput,
): Promise<PrChecksStatus> {
  const doc = await readGitlemDoc(account, input.repoFullName);
  const run = doc.ciRuns.find((r) => r.branch === input.headBranch);
  if (!run) return { supported: true, green: true, state: 'green' };
  if (run.status === 'queued' || run.status === 'running') {
    return { supported: true, green: false, state: 'pending' };
  }
  return run.status === 'success'
    ? { supported: true, green: true, state: 'green' }
    : { supported: true, green: false, state: 'failing' };
}

export function gitlemPrApi(connection: PrConnectionInput): ProviderPrApi {
  // Every operation resolves the connection's token → account first, so each
  // call is scoped to that account (a token can never reach another account's
  // repo) and fails closed (401) on no/invalid token before any repo lookup.
  // Resolution runs per call (no memoization) so it always observes the
  // current connection/DB state.
  return {
    open: (input) => accountForConnection(connection).then((a) => gitlemOpenPullRequest(a, input)),
    merge: (input) => accountForConnection(connection).then((a) => gitlemMergePullRequest(a, input)),
    diff: (input) => accountForConnection(connection).then((a) => gitlemPullRequestDiff(a, input)),
    state: (input) => accountForConnection(connection).then((a) => gitlemPullRequestState(a, input)),
    list: (repoFullName) =>
      accountForConnection(connection).then((a) => gitlemListPullRequests(a, repoFullName)),
    close: (input) => accountForConnection(connection).then((a) => gitlemClosePullRequest(a, input)),
    deleteBranch: (repoFullName, branch) =>
      accountForConnection(connection).then((a) => gitlemDeleteBranch(a, repoFullName, branch)),
    checks: (input) => accountForConnection(connection).then((a) => gitlemChecksStatus(a, input)),
  };
}
