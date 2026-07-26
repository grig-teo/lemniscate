import { withGitlabRefreshRetry } from './token-refresh.js';
import { githubApi } from './git-providers/github.js';
import { gitlabApi } from './git-providers/gitlab.js';
import { gitverseApi } from './git-providers/gitverse.js';
import { giteeApi } from './git-providers/gitee.js';
import { ProviderError } from './git-providers/types.js';
import type {
  GitProviderClient,
  ProviderApi,
  ProviderName,
  ProviderProfile,
  ProviderTokenType,
  PullRequestResult,
} from './git-providers/types.js';

// Per-provider REST clients. Each client talks to the git host's API with
// the connection's decrypted access token and returns normalized shapes so
// routes and the agent worker never deal with provider-specific payloads.
//
// This module is the barrel: provider implementations live in
// git-providers/{github,gitlab,gitverse,gitee}.ts; shared HTTP plumbing,
// bare-repo detection, scope parsing, and clone-URL hygiene live in
// git-providers/{http,bare,scopes,clone-url}.ts. The registry below is the
// ONE place provider-specific behavior is selected (AGENTS.md §4).
//
// `createPullRequest` is part of the interface but intentionally stubbed —
// the worker wave fills it in.

export type {
  CreateFileInput,
  CreatePullRequestInput,
  CreateRepoInput,
  GitProviderClient,
  NormalizedRepo,
  ProviderName,
  ProviderProfile,
  ProviderTokenType,
  PullRequestResult,
} from './git-providers/types.js';
export { ProviderError } from './git-providers/types.js';
export { hasAnyScope } from './git-providers/scopes.js';
export { isBareRootListing } from './git-providers/bare.js';
export { GIT_HTTP_AUTH_USERNAME, tokenlessCloneUrl } from './git-providers/clone-url.js';
export { GITHUB_API, githubHeaders } from './git-providers/github.js';
export { gitlabApiBase, gitlabHeaders } from './git-providers/gitlab.js';
export {
  GITVERSE_ACCEPT,
  GITVERSE_API,
  gitverseApiBase,
  gitverseBase,
  gitverseHeaders,
  normalizeGitverseRepo,
  type GitverseRepo,
} from './git-providers/gitverse.js';
export {
  GITEE_API,
  GITEE_WEB,
  giteeHeaders,
  normalizeGiteeRepo,
  type GiteeRepo,
} from './git-providers/gitee.js';

// The ONE place provider-specific behavior is selected (AGENTS.md §4: a
// switch on the provider type lives in a single location — this registry).
const providerApis: Record<ProviderName, ProviderApi> = {
  github: githubApi,
  gitlab: gitlabApi,
  gitverse: gitverseApi,
  gitee: giteeApi,
};

// Validates a token by fetching the provider profile. Used when connecting
// via PAT. Throws ProviderError on invalid tokens.
export async function fetchProviderProfile(
  provider: ProviderName,
  token: string,
  baseUrl?: string | null,
  tokenType: ProviderTokenType = 'pat',
): Promise<ProviderProfile> {
  return providerApis[provider].profile(token, baseUrl, tokenType);
}

// Pre-flight check run before any agent job: fails fast with an actionable
// ProviderError when the stored token cannot push to the repository, instead
// of discovering the 403 after the LLM work is done.
export async function assertRepoPushAccess(
  provider: ProviderName,
  token: string,
  repoFullName: string,
  baseUrl?: string | null,
  tokenType: ProviderTokenType = 'pat',
): Promise<void> {
  return providerApis[provider].assertPushAccess(token, baseUrl, tokenType, repoFullName);
}

const notImplementedPr = (provider: ProviderName) =>
  async (): Promise<PullRequestResult> => {
    throw new ProviderError(`${provider}: createPullRequest is not implemented yet`);
  };

export function getProviderClient(connection: {
  id?: string;
  provider: ProviderName;
  baseUrl: string | null;
  /** Null on soft-disconnected rows — token resolution rejects with a clear error. */
  accessTokenEnc: string | null;
  tokenType?: string | null;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: Date | null;
}): GitProviderClient {
  const tokenType: ProviderTokenType =
    connection.tokenType === 'oauth' ? 'oauth' : 'pat';
  const api = providerApis[connection.provider];
  return {
    // Token resolution goes through the refresh flow: expired GitLab OAuth
    // tokens are swapped before the call, and a 401 on a legacy row (no
    // stored expiry) triggers one refresh+retry.
    listRepos: () =>
      withGitlabRefreshRetry(connection, (token) =>
        api.listRepos(token, connection.baseUrl, tokenType),
      ),
    createRepo: (input) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.createRepo(token, connection.baseUrl, tokenType, input),
      ),
    createFile: (input) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.createFile(token, connection.baseUrl, tokenType, input),
      ),
    createPullRequest: notImplementedPr(connection.provider),
    isBare: (repoFullName) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.isBare(token, connection.baseUrl, tokenType, repoFullName),
      ),
    listRootEntries: (repoFullName) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.listRoot(token, connection.baseUrl, tokenType, repoFullName),
      ),
  };
}
