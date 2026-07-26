import { z } from 'zod';
import { GITHUB_API, githubHeaders, ProviderError } from './git-providers.js';
import {
  apiRequest,
  apiTextRequest,
  conflictOrThrow,
  createOrFindExistingPr,
  encodeRepoPath,
  fetchAllPages,
  PR_LIST_PAGE_SIZE,
  prStateFromOpenMerged,
  type ListedPullRequest,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type PrChecksStatus,
  type ProviderPrApi,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';

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

const githubCombinedStatusSchema = z.object({ state: z.string(), total_count: z.number() });

const githubCheckRunsSchema = z.object({
  check_runs: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
});

export interface GitHubCombinedStatus {
  state: string;
  total_count: number;
}

export interface GitHubCheckRun {
  status: string;
  conclusion: string | null;
}

// Conclusions that do not block a merge (GitHub Actions docs).
const CHECK_RUN_OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function checkRunOutcome(run: GitHubCheckRun): 'pending' | 'failing' | 'ok' {
  if (run.status !== 'completed') return 'pending';
  return CHECK_RUN_OK_CONCLUSIONS.has(run.conclusion ?? '') ? 'ok' : 'failing';
}

// Gate signal = commit statuses (external CI) AND check runs (GitHub
// Actions). The combined-status endpoint alone never sees Actions runs —
// on an Actions-only repo it reports total_count 0, which must NOT read as
// green on its own. Failing beats pending beats green across both signals.
export function githubChecksState(
  combined: GitHubCombinedStatus,
  checkRuns: GitHubCheckRun[],
): PrChecksStatus['state'] {
  const outcomes = checkRuns.map(checkRunOutcome);
  if (outcomes.includes('failing')) return 'failing';
  if (combined.total_count > 0 && combined.state !== 'success' && combined.state !== 'pending') {
    return 'failing';
  }
  if (outcomes.includes('pending')) return 'pending';
  if (combined.total_count > 0 && combined.state === 'pending') return 'pending';
  return 'green';
}

// CI state of the PR head: commit statuses (external CI) plus check runs
// (GitHub Actions — the only signal Actions produces). filter=latest so a
// re-run supersedes its earlier failed attempt.
async function githubChecksStatus(
  token: string,
  input: PullRequestRefInput,
): Promise<PrChecksStatus> {
  const repoPath = encodeRepoPath(input.repoFullName);
  const ref = encodeURIComponent(input.headBranch);
  const headers = githubHeaders(token);
  const [statusRes, runsRes] = await Promise.all([
    apiRequest('github', 'GET', `${GITHUB_API}/repos/${repoPath}/commits/${ref}/status`, headers, token),
    apiRequest(
      'github',
      'GET',
      `${GITHUB_API}/repos/${repoPath}/commits/${ref}/check-runs?filter=latest&per_page=100`,
      headers,
      token,
    ),
  ]);
  const combined = githubCombinedStatusSchema.parse(statusRes.body);
  const { check_runs } = githubCheckRunsSchema.parse(runsRes.body);
  const state = githubChecksState(combined, check_runs);
  return { supported: true, green: state === 'green', state };
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
  };
}
