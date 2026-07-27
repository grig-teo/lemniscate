import { gitverseApiBase, gitverseBase, gitverseHeaders, ProviderError } from './git-providers.js';
import {
  apiRequest,
  encodeRepoPath,
  type MergePullRequestResult,
  type PrConnectionInput,
  type PullRequestRefInput,
} from './pr-shared.js';

// Low-level GitVerse request helpers: pull-URL builders and the merge-failure
// classification shared by the PR operations in pr-gitverse.ts.

// Merge execution is not part of the documented public API — the message the
// agent loop records so the task stays awaiting_review for a human.
const GITVERSE_MERGE_UNSUPPORTED =
  'gitverse: merge via API is not supported by the public API — merge manually';

// True only when a payload clearly says the PR is not mergeable.
function indicatesUnmergeable(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const state = body as { mergeable?: unknown; mergeable_state?: unknown };
  return state.mergeable === false || state.mergeable_state === 'dirty';
}

export function gitversePullsUrl(connection: PrConnectionInput, repoFullName: string): string {
  return `${gitverseApiBase(connection.baseUrl)}/repos/${encodeRepoPath(repoFullName)}/pulls`;
}

export function gitverseOpenPullsQueryUrl(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): string {
  return (
    `${gitversePullsUrl(connection, input.repoFullName)}?state=open` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

export function gitverseAllPullsQueryUrl(
  connection: PrConnectionInput,
  input: PullRequestRefInput,
): string {
  return (
    `${gitversePullsUrl(connection, input.repoFullName)}?state=all` +
    `&head=${encodeURIComponent(input.headBranch)}&per_page=100`
  );
}

export function gitversePrWebUrl(
  connection: PrConnectionInput,
  repoFullName: string,
  pull: { number: number; html_url?: string },
): string {
  return pull.html_url ?? `${gitverseBase(connection.baseUrl)}/${repoFullName}/pulls/${pull.number}`;
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

export async function gitverseMergeFailure(
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
