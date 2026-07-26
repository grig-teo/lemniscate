import { contentsUrl, fetchRootEntryNames, rootListingIsBare } from './bare.js';
import { postJson, requestJson, base64Content } from './http.js';
import { noPushAccessError } from './scopes.js';
import { ProviderError } from './types.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
} from './types.js';

// Gitee REST client (gitee.com, API v5 — GitHub-shaped). The API mirrors the
// GitHub shapes (full_name, clone_url, pulls) under https://gitee.com/api/v5;
// tokens authenticate as Bearer.

export const GITEE_API = 'https://gitee.com/api/v5';
export const GITEE_WEB = 'https://gitee.com';

export function giteeHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

export interface GiteeRepo {
  id: number | string;
  name: string;
  full_name: string;
  clone_url?: string | null;
  default_branch?: string | null;
}

// Maps the GitHub-shaped API repo to the normalized shape; pure for tests.
// Gitee's default branch is 'master', not 'main'.
export function normalizeGiteeRepo(repo: GiteeRepo): NormalizedRepo {
  return {
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url ?? `${GITEE_WEB}/${repo.full_name}.git`,
    defaultBranch: repo.default_branch ?? 'master',
  };
}

async function giteeListRepos(token: string): Promise<NormalizedRepo[]> {
  const repos: NormalizedRepo[] = [];
  for (let page = 1; ; page += 1) {
    const data = (await requestJson(
      `${GITEE_API}/user/repos?per_page=100&page=${page}`,
      giteeHeaders(token),
      'gitee',
    )) as GiteeRepo[];
    for (const repo of data) {
      repos.push(normalizeGiteeRepo(repo));
    }
    if (data.length < 100) return repos;
  }
}

async function giteeProfile(token: string): Promise<ProviderProfile> {
  const data = (await requestJson(`${GITEE_API}/user`, giteeHeaders(token), 'gitee')) as {
    login?: string;
  };
  if (!data.login) {
    throw new ProviderError('gitee: GET /user did not return a login');
  }
  return { username: data.login };
}

// Gitee's repo payload carries NO permissions object (unlike GitHub), so
// absence means "cannot determine" and passes — only an explicit
// permissions.push === false blocks the job.
async function giteeAssertPushAccess(token: string, repoFullName: string): Promise<void> {
  const data = (await requestJson(
    `${GITEE_API}/repos/${repoFullName}`,
    giteeHeaders(token),
    'gitee',
  )) as { permissions?: { push?: boolean } };
  if (data.permissions?.push === false) {
    throw noPushAccessError('gitee', repoFullName);
  }
}

async function giteeCreateRepo(token: string, input: CreateRepoInput): Promise<NormalizedRepo> {
  const data = (await postJson(`${GITEE_API}/user/repos`, giteeHeaders(token), 'gitee', {
    name: input.name,
    private: input.private ?? false,
  })) as GiteeRepo;
  return normalizeGiteeRepo(data);
}

// POST /repos/{full}/contents/{path} with base64 content (API v5).
async function giteeCreateFile(token: string, input: CreateFileInput): Promise<void> {
  await postJson(
    `${GITEE_API}/repos/${input.repoFullName}/contents/${input.path}`,
    giteeHeaders(token),
    'gitee',
    { message: input.message, content: base64Content(input.content), branch: input.branch },
  );
}

export const giteeApi: ProviderApi = {
  profile: (token) => giteeProfile(token),
  listRepos: (token) => giteeListRepos(token),
  assertPushAccess: (token, _baseUrl, _tokenType, repoFullName) =>
    giteeAssertPushAccess(token, repoFullName),
  createRepo: (token, _baseUrl, _tokenType, input) => giteeCreateRepo(token, input),
  createFile: (token, _baseUrl, _tokenType, input) => giteeCreateFile(token, input),
  isBare: (token, _baseUrl, _tokenType, repoFullName) =>
    rootListingIsBare(contentsUrl(GITEE_API, repoFullName), giteeHeaders(token), 'gitee'),
  listRoot: (token, _baseUrl, _tokenType, repoFullName) =>
    fetchRootEntryNames(contentsUrl(GITEE_API, repoFullName), giteeHeaders(token), 'gitee'),
};
