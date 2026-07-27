import { z } from 'zod';
import { gitverseApiBase, gitverseHeaders, ProviderError } from './git-providers.js';
import {
  gitverseAllPullsQueryUrl,
  gitverseMergeFailure,
  gitverseOpenPullsQueryUrl,
  gitversePrWebUrl,
  gitversePullsUrl,
} from './pr-gitverse-http.js';
import { githubPrReviewCommentListSchema, mapGithubPrReviewComments } from './review-feedback.js';
import {
  apiRequest,
  assembleUnifiedDiff,
  createOrFindExistingPr,
  encodeRepoPath,
  fetchAllPages,
  gitverseDiffFileSchema,
  matchesHeadBaseRef,
  PR_LIST_PAGE_SIZE,
  prStateFromOpenMerged,
  type ListedPullRequest,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type PrConnectionInput,
  type ProviderPrApi,
  type PrReviewComment,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';

// GitVerse pull-request operations (public API: api.<host>, GitHub-shaped
// pulls). The public API exposes no check-status endpoint, so the returned
// ProviderPrApi has no `checks` operation. URL builders and merge-failure
// classification live in pr-gitverse-http.ts.

const gitversePullSchema = z.object({
  number: z.number(),
  html_url: z.string().optional(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
});
const gitversePullListSchema = z.array(gitversePullSchema);
const gitverseCreatedPullSchema = z.object({
  number: z.number(),
  html_url: z.string().optional(),
});

const gitverseCompareSchema = z.object({ files: z.array(gitverseDiffFileSchema) });
const gitverseFilesSchema = z.array(gitverseDiffFileSchema);

// Finds the open PR number for the head branch (numbers are not stored).
async function gitverseLookupPullNumber(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<{ number: number; prUrl: string }> {
  const url = gitverseOpenPullsQueryUrl(connection, input);
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  const match = gitversePullListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  if (!match) {
    throw new ProviderError(
      `gitverse: no open pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return { number: match.number, prUrl: gitversePrWebUrl(connection, input.repoFullName, match) };
}

async function gitverseFindExistingPrUrl(
  connection: PrConnectionInput,
  token: string,
  input: OpenPullRequestInput,
): Promise<string | null> {
  const url = gitverseOpenPullsQueryUrl(connection, input);
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  const match = gitversePullListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  return match ? gitversePrWebUrl(connection, input.repoFullName, match) : null;
}

async function gitverseMergePullRequest(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  const { number, prUrl } = await gitverseLookupPullNumber(connection, token, input);
  const url = `${gitversePullsUrl(connection, input.repoFullName)}/${number}/merge`;
  try {
    // GitHub-style merge execution; the public API may not expose it.
    await apiRequest('gitverse', 'PUT', url, gitverseHeaders(token), token, {});
    return { merged: true, prUrl };
  } catch (err) {
    return gitverseMergeFailure(url, token, prUrl, err);
  }
}

// Preferred diff source: the compare endpoint (documented 'git diff' analog).
async function gitverseCompareDiff(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<string> {
  const url =
    `${gitverseApiBase(connection.baseUrl)}/repos/${encodeRepoPath(input.repoFullName)}` +
    `/compare/${input.baseBranch}...${input.headBranch}`;
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  return assembleUnifiedDiff(gitverseCompareSchema.parse(body).files);
}

async function gitversePullRequestDiff(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<string> {
  try {
    return await gitverseCompareDiff(connection, token, input);
  } catch {
    // Compare unavailable or an unexpected shape — use the PR files endpoint.
  }
  const { number } = await gitverseLookupPullNumber(connection, token, input);
  const url = `${gitversePullsUrl(connection, input.repoFullName)}/${number}/files`;
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  return assembleUnifiedDiff(gitverseFilesSchema.parse(body));
}

// Closes the open PR (no merge) via PATCH /pulls/{n} with state=closed
// (GitHub-shaped API).
async function gitverseClosePullRequest(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<void> {
  const { number } = await gitverseLookupPullNumber(connection, token, input);
  const url = `${gitversePullsUrl(connection, input.repoFullName)}/${number}`;
  await apiRequest('gitverse', 'PATCH', url, gitverseHeaders(token), token, { state: 'closed' });
}

// Deletes the head branch via DELETE /git/refs/heads/{branch} (GitHub-shaped).
async function gitverseDeleteBranch(
  connection: PrConnectionInput,
  token: string,
  repoFullName: string,
  branch: string,
): Promise<void> {
  const repoPath = encodeRepoPath(repoFullName);
  const ref = encodeURIComponent(branch);
  const url = `${gitverseApiBase(connection.baseUrl)}/repos/${repoPath}/git/refs/heads/${ref}`;
  await apiRequest('gitverse', 'DELETE', url, gitverseHeaders(token), token);
}

async function gitverseOpenPullRequest(
  connection: PrConnectionInput,
  token: string,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const url = gitversePullsUrl(connection, input.repoFullName);
  return createOrFindExistingPr({
    create: async () => {
      const { body } = await apiRequest('gitverse', 'POST', url, gitverseHeaders(token), token, {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
      });
      const pull = gitverseCreatedPullSchema.parse(body);
      return gitversePrWebUrl(connection, input.repoFullName, pull);
    },
    // 409/422 = a PR for this head branch already exists.
    alreadyExistsStatuses: [409, 422],
    findExisting: () => gitverseFindExistingPrUrl(connection, token, input),
  });
}

const gitversePullDetailStateSchema = z.object({
  state: z.string(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
});

async function gitversePullRequestState(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<PrState> {
  const url = gitverseAllPullsQueryUrl(connection, input);
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  const match = gitversePullListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  if (!match) {
    throw new ProviderError(
      `gitverse: no pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  const detailUrl = `${gitversePullsUrl(connection, input.repoFullName)}/${match.number}`;
  const detail = await apiRequest('gitverse', 'GET', detailUrl, gitverseHeaders(token), token);
  const pull = gitversePullDetailStateSchema.parse(detail.body);
  return prStateFromOpenMerged(pull.state, pull.merged === true || pull.merged_at != null);
}

const gitverseListedPullSchema = z.array(
  z.object({
    state: z.string(),
    merged_at: z.string().nullable().optional(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
);

// Batched per-repo listing for the state-sync job (GitHub-shaped payload):
// merged_at on the list item avoids one detail request per PR.
async function gitverseListPullRequests(
  connection: PrConnectionInput,
  token: string,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  const pulls = await fetchAllPages(async (page) => {
    const url =
      `${gitversePullsUrl(connection, repoFullName)}?state=all` +
      `&per_page=${PR_LIST_PAGE_SIZE}&page=${page}`;
    const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
    return gitverseListedPullSchema.parse(body);
  });
  return pulls.map((pull) => ({
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    state: prStateFromOpenMerged(pull.state, pull.merged_at != null),
  }));
}

// Human review comments on the PR (GitHub-shaped payload — the schema and
// mapper are shared with pr-github.ts via pr-shared.ts).
async function gitversePullReviewComments(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<PrReviewComment[]> {
  const { number } = await gitverseLookupPullNumber(connection, token, input);
  const url = `${gitversePullsUrl(connection, input.repoFullName)}/${number}/comments?per_page=100`;
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  return mapGithubPrReviewComments(githubPrReviewCommentListSchema.parse(body));
}

export function gitversePrApi(connection: PrConnectionInput, token: string): ProviderPrApi {
  return {
    open: (input) => gitverseOpenPullRequest(connection, token, input),
    merge: (input) => gitverseMergePullRequest(connection, token, input),
    diff: (input) => gitversePullRequestDiff(connection, token, input),
    state: (input) => gitversePullRequestState(connection, token, input),
    list: (repoFullName) => gitverseListPullRequests(connection, token, repoFullName),
    close: (input) => gitverseClosePullRequest(connection, token, input),
    deleteBranch: (repoFullName, branch) =>
      gitverseDeleteBranch(connection, token, repoFullName, branch),
    reviewComments: (input) => gitversePullReviewComments(connection, token, input),
  };
}
