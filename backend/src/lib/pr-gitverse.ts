import { z } from 'zod';
import {
  gitverseApiBase,
  gitverseBase,
  gitverseHeaders,
  ProviderError,
} from './git-providers.js';
import {
  apiRequest,
  assembleUnifiedDiff,
  createOrFindExistingPr,
  encodeRepoPath,
  gitverseDiffFileSchema,
  matchesHeadBaseRef,
  prStateFromOpenMerged,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type PrConnectionInput,
  type ProviderPrApi,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';

// GitVerse pull-request operations (public API: api.<host>, GitHub-shaped
// pulls). The public API exposes no check-status endpoint, so the returned
// ProviderPrApi has no `checks` operation.

// Merge execution is not part of the documented public API — the message the
// agent loop records so the task stays awaiting_review for a human.
const GITVERSE_MERGE_UNSUPPORTED =
  'gitverse: merge via API is not supported by the public API — merge manually';

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

// True only when a payload clearly says the PR is not mergeable.
function indicatesUnmergeable(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const state = body as { mergeable?: unknown; mergeable_state?: unknown };
  return state.mergeable === false || state.mergeable_state === 'dirty';
}

function gitversePullsUrl(connection: PrConnectionInput, repoFullName: string): string {
  return `${gitverseApiBase(connection.baseUrl)}/repos/${encodeRepoPath(repoFullName)}/pulls`;
}

function gitverseOpenPullsQueryUrl(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): string {
  return (
    `${gitversePullsUrl(connection, input.repoFullName)}?state=open` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

function gitversePrWebUrl(
  connection: PrConnectionInput,
  repoFullName: string,
  pull: { number: number; html_url?: string },
): string {
  return pull.html_url ?? `${gitverseBase(connection.baseUrl)}/${repoFullName}/pulls/${pull.number}`;
}

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

// A 409 counts as a conflict only when something clearly says mergeable=false:
// the error body itself, or the documented GET /pulls/{n}/merge status check.
async function gitverseConfirmsConflict(
  mergeUrl: string,
  token: string,
  err: ProviderError,
): Promise<boolean> {
  if (/conflict|mergeable["']?\s*:\s*false/i.test(err.message)) return true;
  try {
    const { body } = await apiRequest('gitverse', 'GET', mergeUrl, gitverseHeaders(token), token);
    return indicatesUnmergeable(body);
  } catch {
    return false; // status check unavailable — cannot confirm a conflict
  }
}

async function gitverseMergeFailure(
  mergeUrl: string,
  token: string,
  prUrl: string,
  err: unknown,
): Promise<MergePullRequestResult> {
  if (!(err instanceof ProviderError)) throw err;
  // 404/405 = the public API has no merge-execution endpoint.
  if (err.status === 404 || err.status === 405) {
    throw new ProviderError(GITVERSE_MERGE_UNSUPPORTED, err.status);
  }
  if (err.status === 409 && (await gitverseConfirmsConflict(mergeUrl, token, err))) {
    return { merged: false, conflict: true, prUrl };
  }
  throw err;
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

function gitverseAllPullsQueryUrl(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): string {
  return (
    `${gitversePullsUrl(connection, input.repoFullName)}?state=all` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

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

export function gitversePrApi(connection: PrConnectionInput, token: string): ProviderPrApi {
  return {
    open: (input) => gitverseOpenPullRequest(connection, token, input),
    merge: (input) => gitverseMergePullRequest(connection, token, input),
    diff: (input) => gitversePullRequestDiff(connection, token, input),
    state: (input) => gitversePullRequestState(connection, token, input),
  };
}
