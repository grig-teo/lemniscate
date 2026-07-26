import { z } from 'zod';
import { GITEE_API, giteeHeaders, ProviderError } from './git-providers.js';
import {
  apiRequest,
  assembleUnifiedDiff,
  conflictOrThrow,
  createOrFindExistingPr,
  encodeRepoPath,
  fetchAllPages,
  gitverseDiffFileSchema,
  matchesHeadBaseRef,
  PR_LIST_PAGE_SIZE,
  prStateFromString,
  type ListedPullRequest,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type ProviderPrApi,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';

// Gitee pull-request operations (API v5 — GitHub-shaped pulls). Gitee has no
// check-status endpoint, so the returned ProviderPrApi has no `checks`.

const giteePullSchema = z.object({ number: z.number(), html_url: z.string() });
const giteePullListSchema = z.array(
  z.object({
    number: z.number(),
    html_url: z.string(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
);
const giteeFilesSchema = z.array(gitverseDiffFileSchema);

function giteePullsUrl(repoFullName: string): string {
  return `${GITEE_API}/repos/${encodeRepoPath(repoFullName)}/pulls`;
}

function giteeOpenPullsQueryUrl(input: PullRequestRefInput): string {
  return (
    `${giteePullsUrl(input.repoFullName)}?state=open` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

// Finds the open PR number for the head branch (PR numbers are not stored).
async function giteeLookupPullNumber(
  token: string,
  input: PullRequestRefInput,
): Promise<{ number: number; prUrl: string }> {
  const { body } = await apiRequest(
    'gitee',
    'GET',
    giteeOpenPullsQueryUrl(input),
    giteeHeaders(token),
    token,
  );
  const match = giteePullListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  if (!match) {
    throw new ProviderError(
      `gitee: no open pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return { number: match.number, prUrl: match.html_url };
}

async function giteeFindExistingPrUrl(
  token: string,
  input: OpenPullRequestInput,
): Promise<string | null> {
  const { body } = await apiRequest(
    'gitee',
    'GET',
    giteeOpenPullsQueryUrl(input),
    giteeHeaders(token),
    token,
  );
  const match = giteePullListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  return match?.html_url ?? null;
}

async function giteeMergePullRequest(
  token: string,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  const { number, prUrl } = await giteeLookupPullNumber(token, input);
  const url = `${giteePullsUrl(input.repoFullName)}/${number}/merge`;
  try {
    await apiRequest('gitee', 'PUT', url, giteeHeaders(token), token, {});
    return { merged: true, prUrl };
  } catch (err) {
    // 405 = not mergeable (conflicts), 409 = head branch moved.
    return conflictOrThrow(err, [405, 409], prUrl);
  }
}

async function giteePullRequestDiff(token: string, input: PullRequestRefInput): Promise<string> {
  const { number } = await giteeLookupPullNumber(token, input);
  const url = `${giteePullsUrl(input.repoFullName)}/${number}/files`;
  const { body } = await apiRequest('gitee', 'GET', url, giteeHeaders(token), token);
  return assembleUnifiedDiff(giteeFilesSchema.parse(body));
}

async function giteeOpenPullRequest(
  token: string,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const url = giteePullsUrl(input.repoFullName);
  return createOrFindExistingPr({
    create: async () => {
      const { body } = await apiRequest('gitee', 'POST', url, giteeHeaders(token), token, {
        title: input.title,
        head: input.headBranch,
        base: input.baseBranch,
        body: input.body,
      });
      return giteePullSchema.parse(body).html_url;
    },
    // 409/422 = a PR for this head branch already exists.
    alreadyExistsStatuses: [409, 422],
    findExisting: () => giteeFindExistingPrUrl(token, input),
  });
}

const giteePullStateListSchema = z.array(
  z.object({
    state: z.string(),
    head: z.object({ ref: z.string() }),
    base: z.object({ ref: z.string() }),
  }),
);

function giteeAllPullsQueryUrl(input: PullRequestRefInput): string {
  return (
    `${giteePullsUrl(input.repoFullName)}?state=all` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

async function giteePullRequestState(token: string, input: PullRequestRefInput): Promise<PrState> {
  const { body } = await apiRequest(
    'gitee',
    'GET',
    giteeAllPullsQueryUrl(input),
    giteeHeaders(token),
    token,
  );
  const match = giteePullStateListSchema.parse(body).find((pull) => matchesHeadBaseRef(pull, input));
  if (!match) {
    throw new ProviderError(
      `gitee: no pull request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return prStateFromString(match.state);
}

// Batched per-repo listing for the state-sync job: the list payload carries
// head/base refs and the state, so one call resolves every awaiting branch.
async function giteeListPullRequests(
  token: string,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  const pulls = await fetchAllPages(async (page) => {
    const url =
      `${giteePullsUrl(repoFullName)}?state=all&per_page=${PR_LIST_PAGE_SIZE}&page=${page}`;
    const { body } = await apiRequest('gitee', 'GET', url, giteeHeaders(token), token);
    return giteePullStateListSchema.parse(body);
  });
  return pulls.map((pull) => ({
    headBranch: pull.head.ref,
    baseBranch: pull.base.ref,
    state: prStateFromString(pull.state),
  }));
}

export function giteePrApi(token: string): ProviderPrApi {
  return {
    open: (input) => giteeOpenPullRequest(token, input),
    merge: (input) => giteeMergePullRequest(token, input),
    diff: (input) => giteePullRequestDiff(token, input),
    state: (input) => giteePullRequestState(token, input),
    list: (repoFullName) => giteeListPullRequests(token, repoFullName),
  };
}
