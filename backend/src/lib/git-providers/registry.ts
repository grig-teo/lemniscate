import { withGitlabRefreshRetry } from '../token-refresh.js';
import { giteeApi } from './gitee.js';
import { githubApi } from './github.js';
import { gitlabApi } from './gitlab.js';
import { gitlemApi } from './gitlem.js';
import { gitverseApi } from './gitverse.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  GitProviderClient,
  NormalizedRepo,
  ProviderApi,
  ProviderName,
  ProviderProfile,
  ProviderTokenType,
  PullRequestResult,
} from './types.js';
import { ProviderError } from './types.js';

// The provider registry: the ONE place a provider is selected by name
// (AGENTS.md §4). Re-exported through the git-providers.ts barrel.

const providerApis: Record<ProviderName, ProviderApi> = {
  github: githubApi,
  gitlab: gitlabApi,
  gitee: giteeApi,
  gitverse: gitverseApi,
  gitlem: gitlemApi,
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
  const tokenType: ProviderTokenType = connection.tokenType === 'oauth' ? 'oauth' : 'pat';
  const api = providerApis[connection.provider];
  return {
    // Token resolution goes through the refresh flow: expired GitLab OAuth
    // tokens are swapped before the call, and a 401 on a legacy row (no
    // stored expiry) triggers one refresh+retry.
    listRepos: (): Promise<NormalizedRepo[]> =>
      withGitlabRefreshRetry(connection, (token) =>
        api.listRepos(token, connection.baseUrl, tokenType),
      ),
    createRepo: (input: CreateRepoInput) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.createRepo(token, connection.baseUrl, tokenType, input),
      ),
    createFile: (input: CreateFileInput) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.createFile(token, connection.baseUrl, tokenType, input),
      ),
    createPullRequest: notImplementedPr(connection.provider),
    isBare: (repoFullName: string) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.isBare(token, connection.baseUrl, tokenType, repoFullName),
      ),
    listRootEntries: (repoFullName: string) =>
      withGitlabRefreshRetry(connection, (token) =>
        api.listRoot(token, connection.baseUrl, tokenType, repoFullName),
      ),
  };
}
