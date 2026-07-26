import { z } from 'zod';
import {
  gitlabApiBase,
  gitlabHeaders,
  ProviderError,
  type ProviderTokenType,
} from './git-providers.js';
import {
  apiRequest,
  conflictOrThrow,
  createOrFindExistingPr,
  fetchAllPages,
  PR_LIST_PAGE_SIZE,
  prStateFromString,
  type ApiResponse,
  type ListedPullRequest,
  type MergePullRequestResult,
  type OpenPullRequestInput,
  type OpenPullRequestResult,
  type PrChecksStatus,
  type PrConnectionInput,
  type ProviderPrApi,
  type PrState,
  type PullRequestRefInput,
} from './pr-shared.js';

// GitLab merge-request operations: open, merge, diff (reassembled from the
// per-file changes payload), state polling, and the head-pipeline status
// used by the auto-merge gate. Self-hosted instances are supported via the
// connection's baseUrl.

const gitlabMrSchema = z.object({ web_url: z.string() });
const gitlabMrListSchema = z.array(z.object({ web_url: z.string() }));
const gitlabMrLookupSchema = z.array(z.object({ iid: z.number(), web_url: z.string() }));
const gitlabMrChangesSchema = z.object({
  changes: z.array(
    z.object({ old_path: z.string(), new_path: z.string(), diff: z.string() }),
  ),
});

function gitlabTokenType(connection: PrConnectionInput): ProviderTokenType {
  return connection.tokenType === 'oauth' ? 'oauth' : 'pat';
}

function gitlabMrsUrl(connection: PrConnectionInput, repoFullName: string): string {
  const project = encodeURIComponent(repoFullName);
  return `${gitlabApiBase(connection.baseUrl)}/projects/${project}/merge_requests`;
}

function gitlabOpenedMrsQueryUrl(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): string {
  return (
    `${gitlabMrsUrl(connection, input.repoFullName)}?state=opened` +
    `&source_branch=${encodeURIComponent(input.headBranch)}` +
    `&target_branch=${encodeURIComponent(input.baseBranch)}`
  );
}

async function gitlabGet(
  connection: PrConnectionInput,
  token: string,
  url: string,
): Promise<ApiResponse> {
  return apiRequest('gitlab', 'GET', url, gitlabHeaders(token, gitlabTokenType(connection)), token);
}

// Finds the open MR iid for the source branch (iids are not stored).
async function gitlabLookupMrIid(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<{ iid: number; prUrl: string }> {
  const { body } = await gitlabGet(connection, token, gitlabOpenedMrsQueryUrl(connection, input));
  const match = gitlabMrLookupSchema.parse(body)[0];
  if (!match) {
    throw new ProviderError(
      `gitlab: no open merge request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return { iid: match.iid, prUrl: match.web_url };
}

async function gitlabFindExistingMrUrl(
  connection: PrConnectionInput,
  token: string,
  input: OpenPullRequestInput,
): Promise<string | null> {
  const { body } = await gitlabGet(connection, token, gitlabOpenedMrsQueryUrl(connection, input));
  return gitlabMrListSchema.parse(body)[0]?.web_url ?? null;
}

async function gitlabMergePullRequest(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  const { iid, prUrl } = await gitlabLookupMrIid(connection, token, input);
  const url = `${gitlabMrsUrl(connection, input.repoFullName)}/${iid}/merge`;
  try {
    await apiRequest(
      'gitlab',
      'PUT',
      url,
      gitlabHeaders(token, gitlabTokenType(connection)),
      token,
      {},
    );
    return { merged: true, prUrl };
  } catch (err) {
    // 406 = merge conflict, 405 = MR not mergeable in its current state.
    return conflictOrThrow(err, [405, 406], prUrl);
  }
}

async function gitlabPullRequestDiff(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<string> {
  const { iid } = await gitlabLookupMrIid(connection, token, input);
  const url = `${gitlabMrsUrl(connection, input.repoFullName)}/${iid}/changes`;
  const { body } = await gitlabGet(connection, token, url);
  // Reassemble a unified-ish diff from the per-file change entries.
  return gitlabMrChangesSchema
    .parse(body)
    .changes.map((change) => `--- a/${change.old_path}\n+++ b/${change.new_path}\n${change.diff}`)
    .join('\n');
}

async function gitlabOpenPullRequest(
  connection: PrConnectionInput,
  token: string,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  const url = gitlabMrsUrl(connection, input.repoFullName);
  return createOrFindExistingPr({
    create: async () => {
      const { body } = await apiRequest(
        'gitlab',
        'POST',
        url,
        gitlabHeaders(token, gitlabTokenType(connection)),
        token,
        {
          source_branch: input.headBranch,
          target_branch: input.baseBranch,
          title: input.title,
          description: input.body,
        },
      );
      return gitlabMrSchema.parse(body).web_url;
    },
    // 409 Conflict (and occasionally 400) = MR already exists for this branch.
    alreadyExistsStatuses: [409, 400],
    findExisting: () => gitlabFindExistingMrUrl(connection, token, input),
  });
}

const gitlabMrPipelineSchema = z.object({
  head_pipeline: z.object({ status: z.string() }).nullish(),
});

// Head pipeline of the MR. No pipeline at all means nothing can block.
async function gitlabChecksStatus(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<PrChecksStatus> {
  const { iid } = await gitlabLookupMrIid(connection, token, input);
  const url = `${gitlabMrsUrl(connection, input.repoFullName)}/${iid}`;
  const { body } = await gitlabGet(connection, token, url);
  const pipeline = gitlabMrPipelineSchema.parse(body).head_pipeline;
  const state: PrChecksStatus['state'] = !pipeline
    ? 'green'
    : pipeline.status === 'success'
      ? 'green'
      : ['running', 'pending', 'created', 'waiting_for_resource', 'preparing'].includes(
            pipeline.status,
          )
        ? 'pending'
        : ['failed', 'canceled'].includes(pipeline.status)
          ? 'failing'
          : 'green'; // skipped/manual pipelines do not block the merge
  return { supported: true, green: state === 'green', state };
}

const gitlabMrStateListSchema = z.array(z.object({ state: z.string() }));

function gitlabAllMrsQueryUrl(connection: PrConnectionInput, input: PullRequestRefInput): string {
  return (
    `${gitlabMrsUrl(connection, input.repoFullName)}?state=all` +
    `&source_branch=${encodeURIComponent(input.headBranch)}` +
    `&target_branch=${encodeURIComponent(input.baseBranch)}`
  );
}

async function gitlabPullRequestState(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<PrState> {
  const { body } = await gitlabGet(connection, token, gitlabAllMrsQueryUrl(connection, input));
  const match = gitlabMrStateListSchema.parse(body)[0];
  if (!match) {
    throw new ProviderError(
      `gitlab: no merge request for ${input.headBranch} -> ${input.baseBranch}`,
    );
  }
  return prStateFromString(match.state);
}

const gitlabListedMrSchema = z.array(
  z.object({
    state: z.string(),
    source_branch: z.string(),
    target_branch: z.string(),
  }),
);

// Batched per-repo listing for the state-sync job: the MR list payload
// carries the state directly, so one call resolves every awaiting branch.
async function gitlabListPullRequests(
  connection: PrConnectionInput,
  token: string,
  repoFullName: string,
): Promise<ListedPullRequest[]> {
  const mrs = await fetchAllPages(async (page) => {
    const url =
      `${gitlabMrsUrl(connection, repoFullName)}?state=all` +
      `&per_page=${PR_LIST_PAGE_SIZE}&page=${page}`;
    const { body } = await gitlabGet(connection, token, url);
    return gitlabListedMrSchema.parse(body);
  });
  return mrs.map((mr) => ({
    headBranch: mr.source_branch,
    baseBranch: mr.target_branch,
    state: prStateFromString(mr.state),
  }));
}

export function gitlabPrApi(connection: PrConnectionInput, token: string): ProviderPrApi {
  return {
    open: (input) => gitlabOpenPullRequest(connection, token, input),
    merge: (input) => gitlabMergePullRequest(connection, token, input),
    diff: (input) => gitlabPullRequestDiff(connection, token, input),
    state: (input) => gitlabPullRequestState(connection, token, input),
    list: (repoFullName) => gitlabListPullRequests(connection, token, repoFullName),
    checks: (input) => gitlabChecksStatus(connection, token, input),
  };
}
