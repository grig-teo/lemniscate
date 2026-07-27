import { z } from 'zod';
import { GITHUB_API, githubHeaders, ProviderError } from './git-providers.js';
import {
  apiRequest,
  apiTextRequest,
  conflictOrThrow,
  createOrFindExistingPr,
  encodeRepoPath,
  fetchAllPages,
  githubPrReviewCommentListSchema,
  mapGithubPrReviewComments,
  PR_LIST_PAGE_SIZE,
  prStateFromOpenMerged,
  type ListedPullRequest,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type ProviderPrApi,
  type PrReviewComment,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';
import { githubChecksStatus } from './pr-github-checks.js';

// CI-check signals live in pr-github-checks.ts; re-exported here so existing
// importers (tests included) keep working.
export { githubChecksState } from './pr-github-checks.js';
export type {
  GitHubCheckRun,
  GitHubCombinedStatus,
  GitHubWorkflowRun,
} from './pr-github-checks.js';

// GitHub pull-request operations: open, merge, diff, state polling, and the
// combined commit status used by the auto-merge gate.

const githubPullSchema = z.object({ html_url: z.string() });
const githubPullListSchema = z.array(
  z.object({ html_url: z.string(), base: z.object({ ref: z.string() }) }),
);
const githubPullLookupSchema = z.array(
  z.object({
    number: z.number(),
    html_url: z.string(),
    base: z.object({ ref: z.string() }),
  }),
);

function githubPullsUrl(repoFullName: string): string {
  return `${GITHUB_API}/repos/${encodeRepoPath(repoFullName)}/pulls`;
}

function githubOpenPullsQueryUrl(input: PullRequestRefInput): string {
  const owner = input.repoFullName.split('/')[0] ?? '';
  return (
    `${githubPullsUrl(input.repoFullName)}?state=open` +
    `&head=${encodeURIComponent(`${owner}:${input.headBranch}`)}&per_page=100`
  );
}

// Finds the open PR number for the head branch (PR numbers are not stored).
async function githubLookupPullNumber(
  token: string,
  input: PullRequestRefInput,
): Promise<{ number: number; prUrl: string }> {
  const { body } = await apiRequest(
    'github',
    'GET',
    githubOpenPullsQueryUrl(input),
    githubHeaders(token),
    token,
  );
  const match = githubPullLookupSchema.parse(body).find((pull) => pull.base.ref === input.baseBranch);
  if (!match) {
    throw new ProviderError(
      `github: no open pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return { number: match.number, prUrl: match.html_url };
}

async function githubFindExistingPrUrl(
  token: string,
  input: OpenPullRequestInput,
): Promise<string | null> {
  const { body } = await apiRequest(
    'github',
    'GET',
    githubOpenPullsQueryUrl(input),
    githubHeaders(token),
    token,
  );
  const match = githubPullListSchema
    .parse(body)
    .find((pull) => pull.base.ref === input.baseBranch);
  return match?.html_url ?? null;
}

async function githubMergePullRequest(
  token: string,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  const { number, prUrl } = await githubLookupPullNumber(token, input);
  const url = `${githubPullsUrl(input.repoFullName)}/${number}/merge`;
  try {
    await apiRequest('github', 'PUT', url, githubHeaders(token), token, {});
    return { merged: true, prUrl };
  } catch (err) {
    // 405 = not mergeable (conflicts/checks), 409 = head branch moved.
    return conflictOrThrow(err, [405, 409], prUrl);
  }
}

async function githubPullRequestDiff(token: string, input: PullRequestRefInput): Promise<string> {
  const { number } = await githubLookupPullNumber(token, input);
  const url = `${githubPullsUrl(input.repoFullName)}/${number}`;
  return apiTextRequest(
    'github',
    url,
    { ...githubHeaders(token), Accept: 'application/vnd.github.diff' },
    token,
  );
}

// Closes the open PR (no merge) via PATCH /pulls/{n} with state=closed.
async function githubClosePullRequest(token: string, input: PullRequestRefInput): Promise<void> {
  const { number } = await githubLookupPullNumber(token, input);
  const url = `${githubPullsUrl(input.repoFullName)}/${number}`;
  await apiRequest('github', 'PATCH', url, githubHeaders(token), token, { state: 'closed' });
}

// Deletes the head branch via DELETE /git/refs/heads/{branch}. Throws on
// protected-branch or permission errors; the caller decides whether to surface.
async function githubDeleteBranch(
  token: string,
  repoFullName: string,
  branch: string,
): Promise<void> {
  const repoPath = encodeRepoPath(repoFullName);
  const ref = encodeURIComponent(branch);
  const url = `${GITHUB_API}/repos/${repoPath}/git/refs/heads/${ref}`;
  await apiRequest('github', 'DELETE', url, githubHeaders(token), token);
}

async function githubOpenPullRequest(
  token: string,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const url = githubPullsUrl(input.repoFullName);
  return createOrFindExistingPr({
    create: async () => {
      const { body } = await apiRequest('github', 'POST', url, githubHeaders(token), token, {
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
      });
      return githubPullSchema.parse(body).html_url;
    },
    // 422 usually means a PR for this head already exists — look it up.
    alreadyExistsStatuses: [422],
    findExisting: () => githubFindExistingPrUrl(token, input),
  });
}

const githubPullStateListSchema = z.array(
  z.object({ number: z.number(), base: z.object({ ref: z.string() }) }),
);
const githubPullDetailStateSchema = z.object({ state: z.string(), merged: z.boolean() });

function githubAllPullsQueryUrl(input: PullRequestRefInput): string {
  const owner = input.repoFullName.split('/')[0] ?? '';
  return (
    `${githubPullsUrl(input.repoFullName)}?state=all` +
    `&head=${encodeURIComponent(`${owner}:${input.headBranch}`)}&per_page=100`
  );
}

// Two requests: the state=all list finds the PR number, the detail reports
// the merged flag (list payloads do not reliably include it).
async function githubPullRequestState(
  token: string,
  input: PullRequestRefInput,
): Promise<PrState> {
  const { body } = await apiRequest(
    'github',
    'GET',
    githubAllPullsQueryUrl(input),
    githubHeaders(token),
    token,
  );
  const match = githubPullStateListSchema
    .parse(body)
    .find((pull) => pull.base.ref === input.baseBranch);
  if (!match) {
    throw new ProviderError(
      `github: no pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  const url = `${githubPullsUrl(input.repoFullName)}/${match.number}`;
  const detail = await apiRequest('github', 'GET', url, githubHeaders(token), token);
  const pull = githubPullDetailStateSchema.parse(detail.body);
  return prStateFromOpenMerged(pull.state, pull.merged);
}

const githubListedPullSchema = z.array(
  z.object({
    state: z.string(),
    merged_at: z.string().nullable().optional(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
);

// Batched per-repo listing for the state-sync job: the state=all pages
// carry merged_at, so the merged flag needs no per-PR detail request.
async function githubListPullRequests(
  token: string,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  const pulls = await fetchAllPages(async (page) => {
    const url =
      `${githubPullsUrl(repoFullName)}?state=all&per_page=${PR_LIST_PAGE_SIZE}&page=${page}`;
    const { body } = await apiRequest('github', 'GET', url, githubHeaders(token), token);
    return githubListedPullSchema.parse(body);
  });
  return pulls.map((pull) => ({
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    state: prStateFromOpenMerged(pull.state, pull.merged_at != null),
  }));
}

// Human review comments on the PR (the pr-state-sync poll fallback). The
// mapper/schema live in pr-shared.ts — GitVerse/Gitea reuse the same shape.
async function githubPullReviewComments(
  token: string,
  input: PullRequestRefInput,
): Promise<PrReviewComment[]> {
  const { number } = await githubLookupPullNumber(token, input);
  const url = `${githubPullsUrl(input.repoFullName)}/${number}/comments?per_page=100`;
  const { body } = await apiRequest('github', 'GET', url, githubHeaders(token), token);
  return mapGithubPrReviewComments(githubPrReviewCommentListSchema.parse(body));
}

export function githubPrApi(token: string): ProviderPrApi {
  return {
    open: (input) => githubOpenPullRequest(token, input),
    merge: (input) => githubMergePullRequest(token, input),
    diff: (input) => githubPullRequestDiff(token, input),
    state: (input) => githubPullRequestState(token, input),
    list: (repoFullName) => githubListPullRequests(token, repoFullName),
    close: (input) => githubClosePullRequest(token, input),
    deleteBranch: (repoFullName, branch) => githubDeleteBranch(token, repoFullName, branch),
    checks: (input) => githubChecksStatus(token, input),
    reviewComments: (input) => githubPullReviewComments(token, input),
  };
}
