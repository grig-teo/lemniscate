import { config } from '../config.js';
import { withGitlabRefreshRetry } from './token-refresh.js';

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

interface JsonMeta {
  data: unknown;
  headers: Headers;
}

async function requestJsonMeta(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<JsonMeta> {
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
  return { data: await response.json(), headers: response.headers };
}

async function requestJson(
  url: string,
  headers: Record<string, string>,
  provider: string,
): Promise<unknown> {
  return (await requestJsonMeta(url, headers, provider)).data;
}

// Parses an OAuth scope list ("repo, read:user" or "repo read:user") and
// reports whether any of the wanted scopes is granted. Single home for scope
// parsing — used by the push pre-flight and the OAuth exchange validation.
export function hasAnyScope(
  granted: string | null | undefined,
  wanted: string[],
): boolean {
  if (!granted) return false;
  const scopes = granted.split(/[\s,]+/).filter(Boolean);
  return wanted.some((scope) => scopes.includes(scope));
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

// Shared failure for the push pre-flight: one message shape for every
// provider so the task error always tells the user how to fix it, with a
// provider-specific hint (a GitHub hint in a GitLab error misleads).
const PUSH_ACCESS_HINTS: Record<ProviderName, string> = {
  github: `'repo' scope or a fine-grained PAT with Contents: write`,
  gitlab: `the 'api' scope and a Developer (or higher) role on the project or its group`,
  gitverse: `a token with write permission on the repository`,
};

function noPushAccessError(provider: ProviderName, repoFullName: string, detail?: string): ProviderError {
  return new ProviderError(
    `${provider}: the stored token has no write (push) access to ${repoFullName}. ` +
      (detail ? `${detail} ` : '') +
      `Reconnect the ${provider} connection with a token that can write to this repository ` +
      `(${PUSH_ACCESS_HINTS[provider]}).`,
  );
}

// GitHub: `permissions.push` alone is not enough — for OAuth tokens it
// reflects the *user's* repo permissions, so a token without the `repo`
// scope still shows push=true and the push then fails with a 403. OAuth and
// classic tokens carry their granted scopes in the X-OAuth-Scopes header;
// fine-grained PATs send no header and are judged by permissions alone.
async function githubAssertPushAccess(token: string, repoFullName: string): Promise<void> {
  const { data, headers } = await requestJsonMeta(
    `${GITHUB_API}/repos/${repoFullName}`,
    githubHeaders(token),
    'github',
  );
  const repo = data as { private?: boolean; permissions?: { push?: boolean } };
  if (repo.permissions?.push !== true) {
    throw noPushAccessError('github', repoFullName);
  }
  const grantedScopes = headers.get('x-oauth-scopes');
  if (grantedScopes === null) return;
  const wanted = repo.private === false ? ['repo', 'public_repo'] : ['repo'];
  if (hasAnyScope(grantedScopes, wanted)) return;
  throw noPushAccessError(
    'github',
    repoFullName,
    `The token's OAuth scopes (${grantedScopes}) do not include '${wanted[0]}'.`,
  );
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

// GitLab: pushing needs Developer (access_level 30) or above, from either
// project membership or the containing namespace/group.
const GITLAB_DEVELOPER_ACCESS = 30;

async function gitlabAssertPushAccess(
  token: string,
  tokenType: ProviderTokenType,
  repoFullName: string,
): Promise<void> {
  const data = (await requestJson(
    `${gitlabApiBase()}/projects/${encodeURIComponent(repoFullName)}`,
    gitlabHeaders(token, tokenType),
    'gitlab',
  )) as {
    permissions?: {
      project_access?: { access_level?: number } | null;
      // GitLab reports inherited group membership as `group_access`.
      group_access?: { access_level?: number } | null;
    };
  };
  const level = Math.max(
    data.permissions?.project_access?.access_level ?? 0,
    data.permissions?.group_access?.access_level ?? 0,
  );
  if (level >= GITLAB_DEVELOPER_ACCESS) return;
  throw noPushAccessError('gitlab', repoFullName);
}

// ---------------------------------------------------------------------------
// GitVerse
// ---------------------------------------------------------------------------

// GitVerse's public API (gitverse.ru/docs/developers/public-api) is
// GitHub-shaped and lives on the api. subdomain of the instance. Every call
// needs the vendor Accept header; tokens authenticate as Bearer.
// Cloning works over HTTPS with the token embedded (see cloneUrlWithToken).

export const GITVERSE_API = 'https://api.gitverse.ru';
export const GITVERSE_ACCEPT = 'application/vnd.gitverse.object+json;version=1';

// Web base URL of the GitVerse instance (clone + PR page URLs).
export function gitverseBase(baseUrl?: string | null): string {
  return (baseUrl ?? config.GITVERSE_BASE_URL).replace(/\/+$/, '');
}

// REST API base for a connection: the api. subdomain of the web host.
export function gitverseApiBase(baseUrl?: string | null): string {
  if (!baseUrl) return GITVERSE_API;
  return `https://api.${new URL(gitverseBase(baseUrl)).host}`;
}

export function gitverseHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: GITVERSE_ACCEPT };
}

export interface GitverseRepo {
  id: number | string;
  name: string;
  full_name: string;
  clone_url?: string | null;
  default_branch?: string | null;
}

// Maps the GitHub-shaped API repo to the normalized shape; pure for tests.
export function normalizeGitverseRepo(
  repo: GitverseRepo,
  baseUrl?: string | null,
): NormalizedRepo {
  return {
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url ?? `${gitverseBase(baseUrl)}/${repo.full_name}.git`,
    defaultBranch: repo.default_branch ?? 'main',
  };
}

async function gitverseListRepos(
  baseUrl: string | null | undefined,
  token: string,
): Promise<NormalizedRepo[]> {
  const repos: NormalizedRepo[] = [];
  // Paginate with page/per_page (the API also sends Link rel="next"; a short
  // page means we are done either way).
  for (let page = 1; ; page += 1) {
    const data = (await requestJson(
      `${gitverseApiBase(baseUrl)}/user/repos?per_page=100&page=${page}`,
      gitverseHeaders(token),
      'gitverse',
    )) as GitverseRepo[];
    for (const repo of data) {
      repos.push(normalizeGitverseRepo(repo, baseUrl));
    }
    if (data.length < 100) return repos;
  }
}

async function gitverseProfile(
  baseUrl: string | null | undefined,
  token: string,
): Promise<ProviderProfile> {
  const data = (await requestJson(
    `${gitverseApiBase(baseUrl)}/user`,
    gitverseHeaders(token),
    'gitverse',
  )) as { login?: string };
  if (!data.login) {
    throw new ProviderError('gitverse: GET /user did not return a login');
  }
  return { username: data.login };
}

// GitVerse's API is GitHub-shaped, but support for the `permissions` field
// is unverified — a missing object means "cannot determine" and passes
// rather than blocking the job; an explicit push=false still fails fast.
async function gitverseAssertPushAccess(
  baseUrl: string | null | undefined,
  token: string,
  repoFullName: string,
): Promise<void> {
  const data = (await requestJson(
    `${gitverseApiBase(baseUrl)}/repos/${repoFullName}`,
    gitverseHeaders(token),
    'gitverse',
  )) as { permissions?: { push?: boolean } };
  if (data.permissions?.push === false) {
    throw noPushAccessError('gitverse', repoFullName);
  }
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
  assertPushAccess(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
    repoFullName: string,
  ): Promise<void>;
}

const providerApis: Record<ProviderName, ProviderApi> = {
  github: {
    profile: (token) => githubProfile(token),
    listRepos: (token) => githubListRepos(token),
    assertPushAccess: (token, _baseUrl, _tokenType, repoFullName) =>
      githubAssertPushAccess(token, repoFullName),
  },
  gitlab: {
    profile: (token, _baseUrl, tokenType) => gitlabProfile(token, tokenType),
    listRepos: (token, _baseUrl, tokenType) => gitlabListRepos(token, tokenType),
    assertPushAccess: (token, _baseUrl, tokenType, repoFullName) =>
      gitlabAssertPushAccess(token, tokenType, repoFullName),
  },
  gitverse: {
    profile: (token, baseUrl) => gitverseProfile(baseUrl, token),
    listRepos: (token, baseUrl) => gitverseListRepos(baseUrl, token),
    assertPushAccess: (token, baseUrl, _tokenType, repoFullName) =>
      gitverseAssertPushAccess(baseUrl, token, repoFullName),
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
  accessTokenEnc: string;
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
    createPullRequest: notImplementedPr(connection.provider),
  };
}
