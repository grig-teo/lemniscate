import { config } from '../config.js';
import { decrypt } from './crypto.js';

// Per-provider REST clients. Each client talks to the git host's API with
// the connection's decrypted access token and returns normalized shapes so
// routes and the agent worker never deal with provider-specific payloads.
//
// `createPullRequest` is part of the interface but intentionally stubbed —
// the worker wave fills it in.

export interface NormalizedRepo {
  externalId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface CreatePullRequestInput {
  repoFullName: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  url: string;
  number: number;
}

export interface ProviderProfile {
  username: string;
}

export interface GitProviderClient {
  listRepos(): Promise<NormalizedRepo[]>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>;
}

export type ProviderName = 'github' | 'gitverse' | 'gitlab';

// How a stored token authenticates with the provider. Only GitLab differs:
// OAuth access tokens need `Authorization: Bearer`, personal access tokens
// use the `PRIVATE-TOKEN` header.
export type ProviderTokenType = 'pat' | 'oauth';

// Error carrying the HTTP status from the provider, so callers can surface
// a meaningful message (e.g. invalid PAT on connect).
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    throw new ProviderError(
      `${provider}: request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      `${provider}: ${response.status} ${response.statusText} from ${url}: ${body.slice(0, 300)}`,
      response.status,
    );
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GITHUB_API = 'https://api.github.com';

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lemniscate',
  };
}

interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string | null;
}

async function githubListRepos(token: string): Promise<NormalizedRepo[]> {
  const repos: NormalizedRepo[] = [];
  // Paginate: /user/repos returns up to 100 per page.
  for (let page = 1; ; page += 1) {
    const data = (await requestJson(
      `${GITHUB_API}/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
      githubHeaders(token),
      'github',
    )) as GithubRepo[];
    for (const repo of data) {
      repos.push({
        externalId: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch ?? 'main',
      });
    }
    if (data.length < 100) return repos;
  }
}

async function githubProfile(token: string): Promise<ProviderProfile> {
  const data = (await requestJson(`${GITHUB_API}/user`, githubHeaders(token), 'github')) as {
    login: string;
  };
  return { username: data.login };
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

const GITLAB_API = 'https://gitlab.com';

// Base URL of the GitLab REST API for a connection (self-hosted allowed).
export function gitlabApiBase(baseUrl?: string | null): string {
  return `${(baseUrl ?? GITLAB_API).replace(/\/+$/, '')}/api/v4`;
}

export function gitlabHeaders(
  token: string,
  tokenType: ProviderTokenType = 'pat',
): Record<string, string> {
  if (tokenType === 'oauth') {
    return { Authorization: `Bearer ${token}` };
  }
  return { 'PRIVATE-TOKEN': token };
}

interface GitlabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  default_branch: string | null;
}

async function gitlabListRepos(
  token: string,
  tokenType: ProviderTokenType = 'pat',
): Promise<NormalizedRepo[]> {
  const repos: NormalizedRepo[] = [];
  for (let page = 1; ; page += 1) {
    const data = (await requestJson(
      `${gitlabApiBase()}/projects?membership=true&per_page=100&page=${page}`,
      gitlabHeaders(token, tokenType),
      'gitlab',
    )) as GitlabProject[];
    for (const project of data) {
      repos.push({
        externalId: String(project.id),
        name: project.path,
        fullName: project.path_with_namespace,
        cloneUrl: project.http_url_to_repo,
        defaultBranch: project.default_branch ?? 'main',
      });
    }
    if (data.length < 100) return repos;
  }
}

async function gitlabProfile(
  token: string,
  tokenType: ProviderTokenType = 'pat',
): Promise<ProviderProfile> {
  const data = (await requestJson(
    `${gitlabApiBase()}/user`,
    gitlabHeaders(token, tokenType),
    'gitlab',
  )) as { username: string };
  return { username: data.username };
}

// ---------------------------------------------------------------------------
// GitVerse
// ---------------------------------------------------------------------------

// GitVerse's public API is limited and partially undocumented; the calls are
// isolated here so failures surface with a clear, provider-specific error.
// Cloning always works over HTTPS with the token embedded (see
// cloneUrlWithToken), regardless of API availability.

export function gitverseBase(baseUrl?: string | null): string {
  return (baseUrl ?? config.GITVERSE_BASE_URL).replace(/\/+$/, '');
}

// GitVerse exposes a Gitea-style API: PATs go in the Authorization header.
export function gitverseHeaders(token: string): Record<string, string> {
  return { Authorization: `token ${token}` };
}

async function gitverseApi(
  baseUrl: string | null | undefined,
  token: string,
  path: string,
): Promise<unknown> {
  try {
    return await requestJson(`${gitverseBase(baseUrl)}${path}`, gitverseHeaders(token), 'gitverse');
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new ProviderError(
        `gitverse: API call ${path} failed (${err.message}). ` +
          'The GitVerse API is limited; if this endpoint is unavailable, ' +
          'cloning still works via the HTTPS token URL.',
        err.status,
      );
    }
    throw err;
  }
}

interface GitverseRepo {
  id: number | string;
  name: string;
  full_name: string;
  clone_url?: string;
  default_branch?: string | null;
}

async function gitverseListRepos(
  baseUrl: string | null | undefined,
  token: string,
): Promise<NormalizedRepo[]> {
  const data = (await gitverseApi(baseUrl, token, '/api/v1/user/repos?limit=100')) as
    | GitverseRepo[]
    | { repos?: GitverseRepo[] };
  const list = Array.isArray(data) ? data : (data.repos ?? []);
  const base = gitverseBase(baseUrl);
  return list.map((repo) => ({
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url ?? `${base}/${repo.full_name}.git`,
    defaultBranch: repo.default_branch ?? 'main',
  }));
}

async function gitverseProfile(
  baseUrl: string | null | undefined,
  token: string,
): Promise<ProviderProfile> {
  const data = (await gitverseApi(baseUrl, token, '/api/v1/user')) as {
    login?: string;
    username?: string;
  };
  const username = data.login ?? data.username;
  if (!username) {
    throw new ProviderError('gitverse: /api/v1/user did not return a username');
  }
  return { username };
}

// Returns an https clone URL with the token embedded, for use at clone time
// (never persisted to the database).
export function cloneUrlWithToken(cloneUrl: string, token: string): string {
  const url = new URL(cloneUrl);
  url.username = 'oauth2';
  url.password = token;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// The ONE place provider-specific behavior is selected (AGENTS.md §4: a
// switch on the provider type lives in a single location — this registry).
interface ProviderApi {
  profile(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
  ): Promise<ProviderProfile>;
  listRepos(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
  ): Promise<NormalizedRepo[]>;
}

const providerApis: Record<ProviderName, ProviderApi> = {
  github: {
    profile: (token) => githubProfile(token),
    listRepos: (token) => githubListRepos(token),
  },
  gitlab: {
    profile: (token, _baseUrl, tokenType) => gitlabProfile(token, tokenType),
    listRepos: (token, _baseUrl, tokenType) => gitlabListRepos(token, tokenType),
  },
  gitverse: {
    profile: (token, baseUrl) => gitverseProfile(baseUrl, token),
    listRepos: (token, baseUrl) => gitverseListRepos(baseUrl, token),
  },
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

const notImplementedPr = (provider: ProviderName) =>
  async (): Promise<PullRequestResult> => {
    throw new ProviderError(`${provider}: createPullRequest is not implemented yet`);
  };

export function getProviderClient(connection: {
  provider: ProviderName;
  baseUrl: string | null;
  accessTokenEnc: string;
  tokenType?: string | null;
}): GitProviderClient {
  const token = decrypt(connection.accessTokenEnc);
  const tokenType: ProviderTokenType =
    connection.tokenType === 'oauth' ? 'oauth' : 'pat';
  const api = providerApis[connection.provider];
  return {
    listRepos: () => api.listRepos(token, connection.baseUrl, tokenType),
    createPullRequest: notImplementedPr(connection.provider),
  };
}
