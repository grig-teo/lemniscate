import { z } from 'zod';
import { decrypt } from './crypto.js';
import {
  GITHUB_API,
  githubHeaders,
  gitlabApiBase,
  gitlabHeaders,
  gitverseApiBase,
  gitverseBase,
  gitverseHeaders,
  ProviderError,
  type ProviderName,
  type ProviderTokenType,
} from './git-providers.js';
import { errorMessage, redactSecrets } from './utils.js';

// Opens pull/merge requests on the connected git host. Kept separate from
// git-providers.ts (which owns token validation + repo listing) so the
// worker's PR flow is isolated and easy to audit.
//
// Security: the decrypted token lives only in memory; it is scrubbed from
// any error message that could reach a log or task event.

export interface PrConnectionInput {
  provider: ProviderName;
  baseUrl: string | null;
  accessTokenEnc: string;
  /** 'pat' | 'oauth' — GitLab OAuth tokens need Bearer, everything else PRIVATE-TOKEN. */
  tokenType?: string | null;
}

export interface OpenPullRequestInput {
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  title: string;
  body: string;
}

export interface OpenPullRequestResult {
  prUrl: string;
}

export interface PullRequestRefInput {
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
}

export interface MergePullRequestResult {
  merged: boolean;
  /** True when the provider refused the merge because of conflicts. */
  conflict?: boolean;
  prUrl: string;
}

// Maps a provider "not mergeable" status to a conflict result; rethrows
// anything else so real API failures are not mistaken for conflicts.
function conflictOrThrow(err: unknown, statuses: number[], prUrl: string): MergePullRequestResult {
  if (err instanceof ProviderError && err.status !== undefined && statuses.includes(err.status)) {
    return { merged: false, conflict: true, prUrl };
  }
  throw err;
}

// `scrub` keeps the historical call-site name; the implementation lives in
// utils.ts (single home, shared with agent-loop and llm-client).
const scrub = (text: string, token: string): string => redactSecrets(text, [token]);

interface ApiResponse {
  status: number;
  body: unknown;
}

async function fetchOrThrow(provider: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new ProviderError(`${provider}: request to ${url} failed: ${errorMessage(err)}`);
  }
}

// Never includes the token in the error message.
function httpError(
  provider: string,
  what: string,
  status: number,
  bodyText: string,
  token: string,
): ProviderError {
  return new ProviderError(
    `${provider}: HTTP ${status} from ${what}: ${scrub(bodyText, token).slice(0, 300)}`,
    status,
  );
}

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Small JSON helper: throws ProviderError (with status) on non-2xx so callers
// can branch on 'already exists' statuses. Never includes the token in errors.
async function apiRequest(
  provider: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string>,
  token: string,
  body?: unknown,
): Promise<ApiResponse> {
  const response = await fetchOrThrow(provider, url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw httpError(provider, `${method} ${url}`, response.status, text, token);
  }
  return { status: response.status, body: parseJsonOrNull(text) };
}

// Raw-text variant for diff endpoints (which do not return JSON).
async function apiTextRequest(
  provider: string,
  url: string,
  headers: Record<string, string>,
  token: string,
): Promise<string> {
  const response = await fetchOrThrow(provider, url, { headers });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw httpError(provider, `GET ${url}`, response.status, text, token);
  }
  return text;
}

export interface CreateOrFindExistingPrOptions {
  /** Creates the PR; returns its URL. */
  create: () => Promise<string>;
  /** HTTP statuses meaning "a PR for this branch already exists". */
  alreadyExistsStatuses: number[];
  /** Looks up the existing PR's URL; null when there is none. */
  findExisting: () => Promise<string | null>;
}

// Shared "create the PR, recover the existing one on a conflict status"
// flow — previously copy-pasted across the three provider implementations.
export async function createOrFindExistingPr(
  options: CreateOrFindExistingPrOptions,
): Promise<OpenPullRequestResult> {
  try {
    return { prUrl: await options.create() };
  } catch (err) {
    if (
      !(err instanceof ProviderError) ||
      !options.alreadyExistsStatuses.includes(err.status ?? -1)
    ) {
      throw err;
    }
    const existing = await options.findExisting();
    if (!existing) throw err;
    return { prUrl: existing };
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

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
  return `${GITHUB_API}/repos/${repoFullName}/pulls`;
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

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// GitVerse (public API: api.<host>, GitHub-shaped pulls)
// ---------------------------------------------------------------------------

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

// One file entry of a compare / pull-files payload (GitHub-shaped).
export interface GitverseDiffFile {
  filename: string;
  previous_filename?: string;
  patch?: string;
}

const gitverseDiffFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  patch: z.string().optional(),
});
const gitverseCompareSchema = z.object({ files: z.array(gitverseDiffFileSchema) });
const gitverseFilesSchema = z.array(gitverseDiffFileSchema);

// Assembles unified-diff text from per-file patches. Pure for tests.
export function assembleUnifiedDiff(files: GitverseDiffFile[]): string {
  return files
    .map((file) => {
      const oldPath = file.previous_filename ?? file.filename;
      return (
        `diff --git a/${oldPath} b/${file.filename}\n` +
        `--- a/${oldPath}\n+++ b/${file.filename}\n${file.patch ?? ''}`
      );
    })
    .join('\n');
}

// True only when a payload clearly says the PR is not mergeable.
function indicatesUnmergeable(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const state = body as { mergeable?: unknown; mergeable_state?: unknown };
  return state.mergeable === false || state.mergeable_state === 'dirty';
}

function gitversePullsUrl(connection: PrConnectionInput, repoFullName: string): string {
  return `${gitverseApiBase(connection.baseUrl)}/repos/${repoFullName}/pulls`;
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

function matchesGitverseRef(
  pull: { head: { ref: string }; base: { ref: string } },
  input: PullRequestRefInput,
): boolean {
  return pull.head.ref === input.headBranch && pull.base.ref === input.baseBranch;
}

// Finds the open PR number for the head branch (numbers are not stored).
async function gitverseLookupPullNumber(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<{ number: number; prUrl: string }> {
  const url = gitverseOpenPullsQueryUrl(connection, input);
  const { body } = await apiRequest('gitverse', 'GET', url, gitverseHeaders(token), token);
  const match = gitversePullListSchema.parse(body).find((pull) => matchesGitverseRef(pull, input));
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
  const match = gitversePullListSchema.parse(body).find((pull) => matchesGitverseRef(pull, input));
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
    `${gitverseApiBase(connection.baseUrl)}/repos/${input.repoFullName}` +
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

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

interface ProviderPrApi {
  open(input: OpenPullRequestInput): Promise<OpenPullRequestResult>;
  merge(input: PullRequestRefInput): Promise<MergePullRequestResult>;
  diff(input: PullRequestRefInput): Promise<string>;
}

// The ONE place the provider is selected for PR operations (AGENTS.md §4).
function providerPrApi(connection: PrConnectionInput): ProviderPrApi {
  const token = decrypt(connection.accessTokenEnc);
  switch (connection.provider) {
    case 'github':
      return {
        open: (input) => githubOpenPullRequest(token, input),
        merge: (input) => githubMergePullRequest(token, input),
        diff: (input) => githubPullRequestDiff(token, input),
      };
    case 'gitlab':
      return {
        open: (input) => gitlabOpenPullRequest(connection, token, input),
        merge: (input) => gitlabMergePullRequest(connection, token, input),
        diff: (input) => gitlabPullRequestDiff(connection, token, input),
      };
    case 'gitverse':
      return {
        open: (input) => gitverseOpenPullRequest(connection, token, input),
        merge: (input) => gitverseMergePullRequest(connection, token, input),
        diff: (input) => gitversePullRequestDiff(connection, token, input),
      };
  }
}

export async function openPullRequest(
  connection: PrConnectionInput,
  input: OpenPullRequestInput,
): Promise<OpenPullRequestResult> {
  return providerPrApi(connection).open(input);
}

// Merges the open PR for the head branch into the base branch. A provider
// refusal due to conflicts comes back as { merged: false, conflict: true }
// so the caller can hand resolution to the agent and retry.
export async function mergePullRequest(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<MergePullRequestResult> {
  return providerPrApi(connection).merge(input);
}

// Unified diff text of the open PR for the head branch, for the LLM review.
export async function getPullRequestDiff(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): Promise<string> {
  return providerPrApi(connection).diff(input);
}
