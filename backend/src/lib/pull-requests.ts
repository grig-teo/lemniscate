import { withGitlabRefreshRetry } from './token-refresh.js';
import { githubPrApi } from './pr-github.js';
import { gitlabPrApi } from './pr-gitlab.js';
import { gitversePrApi } from './pr-gitverse.js';
import { giteePrApi } from './pr-gitee.js';
import type {
  ListedPullRequest,
  MergePullRequestResult,
  OpenPullRequestInput,
  OpenPullRequestResult,
  PrChecksStatus,
  PrConnectionInput,
  ProviderPrApi,
  PrReviewComment,
  PrState,
  PullRequestRefInput,
} from './pr-shared.js';

// Opens pull/merge requests on the connected git host. Kept separate from
// git-providers.ts (which owns token validation + repo listing) so the
// worker's PR flow is isolated and easy to audit.
//
// This module is the barrel: provider implementations live in pr-github.ts,
// pr-gitlab.ts, pr-gitverse.ts, and pr-gitee.ts; shared types and HTTP
// plumbing live in pr-shared.ts. The provider switch below is the ONE place
// the provider is selected for PR operations (AGENTS.md §4).
//
// Security: the decrypted token lives only in memory; it is scrubbed from
// any error message that could reach a log or task event.

export type {
  CreateOrFindExistingPrOptions,
  GitverseDiffFile,
  ListedPullRequest,
  MergePullRequestResult,
  OpenPullRequestInput,
  OpenPullRequestResult,
  PrChecksStatus,
  PrConnectionInput,
  PrReviewComment,
  PrState,
  PullRequestRefInput,
} from './pr-shared.js';
export {
  assembleUnifiedDiff,
  createOrFindExistingPr,
  prStateFromOpenMerged,
  prStateFromString,
} from './pr-shared.js';

// The ONE place the provider is selected for PR operations (AGENTS.md §4).
// The token is resolved by the caller (via the refresh flow) and passed in.
function providerPrApi(connection: PrConnectionInput, token: string): ProviderPrApi {
  switch (connection.provider) {
    case 'github':
      return githubPrApi(token);
    case 'gitlab':
      return gitlabPrApi(connection, token);
    case 'gitverse':
      return gitversePrApi(connection, token);
    case 'gitee':
      return giteePrApi(token);
  }
}

export async function openPullRequest(
  connection: PrConnectionInput,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).open(input),
  );
}

// Merges the open PR for the head branch into the base branch. A provider
// refusal due to conflicts comes back as { merged: false, conflict: true }
// so the caller can hand resolution to the agent and retry.
export async function mergePullRequest(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).merge(input),
  );
}

// Unified diff text of the open PR for the head branch, for the LLM review.
export async function getPullRequestDiff(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<string> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).diff(input),
  );
}

// Check statuses of the PR head, for the auto-merge gate. Providers without
// a checks API report { supported: false } so the caller can log and decide.
export async function pullRequestChecksStatus(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<PrChecksStatus> {
  return withGitlabRefreshRetry(connection, (token) => {
    const checks = providerPrApi(connection, token).checks;
    if (!checks) return Promise.resolve({ supported: false, green: true, state: 'green' });
    return checks(input);
  });
}

// Human review comments on the PR (the pr-state-sync poll fallback for
// hosts without webhooks). Providers without a review-comment API report an
// empty list — the poll simply finds nothing to address.
export async function listPrReviewComments(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<PrReviewComment[]> {
  return withGitlabRefreshRetry(connection, (token) => {
    const reviewComments = providerPrApi(connection, token).reviewComments;
    if (!reviewComments) return Promise.resolve([]);
    return reviewComments(input);
  });
}

// open/merged/closed state of the PR for the head branch. Throws when no PR
// exists for the branch pair — the caller decides what that means.
export async function pullRequestState(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<PrState> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).state(input),
  );
}

// Closes the open PR for the head branch (no merge). The head branch is left
// in place — deleteBranch is a separate call so a branch-protection failure
// does not strand the PR in an open state.
export async function closePullRequest(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<void> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).close(input),
  );
}

// Deletes the head branch from the remote. Best-effort at the call site: a
// branch-protection refusal or a missing branch should not fail the whole
// close-PR operation — the caller logs and continues.
export async function deleteBranch(
  connection: PrConnectionInput,
  repoFullName: string,
  branch: string,
): Promise<void> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).deleteBranch(repoFullName, branch),
  );
}

// Batched listing of all PRs of a repo (open + recently closed), for the
// pr-state-sync job: one list call replaces one state call per task. The
// result is capped at a few pages — callers fall back to pullRequestState
// for branches the listing did not cover.
export async function listPullRequests(
  connection: PrConnectionInput,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  return withGitlabRefreshRetry(connection, (token) =>
    providerPrApi(connection, token).list(repoFullName),
  );
}
