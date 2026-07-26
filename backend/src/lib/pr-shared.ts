import { z } from 'zod';
import { ProviderError, type ProviderName } from './git-providers.js';
import { errorMessage, redactSecrets } from './utils.js';

// Shared types and HTTP plumbing for the pull-request provider modules
// (pr-github.ts, pr-gitlab.ts, pr-gitverse.ts, pr-gitee.ts). Kept separate
// from git-providers.ts (which owns token validation + repo listing) so the
// worker's PR flow is isolated and easy to audit.
//
// Security: the decrypted token lives only in memory; it is scrubbed from
// any error message that could reach a log or task event.

export interface PrConnectionInput {
  provider: ProviderName;
  baseUrl: string | null;
  /** Null on soft-disconnected rows — token resolution rejects with a clear error. */
  accessTokenEnc: string | null;
  /** 'pat' | 'oauth' — GitLab OAuth tokens need Bearer, everything else PRIVATE-TOKEN. */
  tokenType?: string | null;
  /** Refresh-flow fields (migration 0006); optional for partial selections. */
  id?: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
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

export interface PrChecksStatus {
  /** False when the provider exposes no check-status API (e.g. GitVerse). */
  supported: boolean;
  /** True when every check is green — or none exist to block the merge. */
  green: boolean;
  /** Three-way gate state: pending re-checks later, failing triggers a CI fix. */
  state: 'green' | 'pending' | 'failing';
}

export type PrState = 'open' | 'merged' | 'closed';

/** Maps an explicit provider state string ('merged'/'closed'/'open'…) to a PrState. */
export function prStateFromString(state: string): PrState {
  if (state === 'merged') return 'merged';
  if (state === 'open' || state === 'opened') return 'open';
  return 'closed';
}

/** Maps a GitHub-shaped { state, merged } pair to a PrState. */
export function prStateFromOpenMerged(state: string, merged: boolean): PrState {
  if (merged) return 'merged';
  return prStateFromString(state);
}

// The provider operations the public entry points dispatch to. `checks` is
// absent when the provider has no checks API.
export interface ProviderPrApi {
  open(input: OpenPullRequestInput): Promise<OpenPullRequestResult>;
  merge(input: PullRequestRefInput): Promise<MergePullRequestResult>;
  diff(input: PullRequestRefInput): Promise<string>;
  state(input: PullRequestRefInput): Promise<PrState>;
  /** Commit/PR check statuses; absent when the provider has no checks API. */
  checks?(input: PullRequestRefInput): Promise<PrChecksStatus>;
}

// Maps a provider "not mergeable" status to a conflict result; rethrows
// anything else so real API failures are not mistaken for conflicts.
export function conflictOrThrow(
  err: unknown,
  statuses: number[],
  prUrl: string,
): MergePullRequestResult {
  if (err instanceof ProviderError && err.status !== undefined && statuses.includes(err.status)) {
    return { merged: false, conflict: true, prUrl };
  }
  throw err;
}

// `scrub` keeps the historical call-site name; the implementation lives in
// utils.ts (single home, shared with agent-loop and llm-client).
const scrub = (text: string, token: string): string => redactSecrets(text, [token]);

export interface ApiResponse {
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
export async function apiRequest(
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
export async function apiTextRequest(
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

// Each repoFullName path segment is encoded separately: '/' keeps separating
// owner/repo, but special characters in either segment cannot break out of
// the URL path or smuggle in query strings.
export function encodeRepoPath(repoFullName: string): string {
  return repoFullName.split('/').map(encodeURIComponent).join('/');
}

// One file entry of a compare / pull-files payload (GitHub-shaped — used by
// the GitVerse and Gitee diff endpoints).
export interface GitverseDiffFile {
  filename: string;
  previous_filename?: string;
  patch?: string;
}

export const gitverseDiffFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  patch: z.string().optional(),
});

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

// Matches a GitHub-shaped { head, base } pull payload against the requested
// branch pair (shared by the GitVerse and Gitee list endpoints).
export function matchesHeadBaseRef(
  pull: { head: { ref: string }; base: { ref: string } },
  input: PullRequestRefInput,
): boolean {
  return pull.head.ref === input.headBranch && pull.base.ref === input.baseBranch;
}
