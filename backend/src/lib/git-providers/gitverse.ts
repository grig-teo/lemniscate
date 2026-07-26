import { config } from '../../config.js';
import { contentsUrl, fetchRootEntryNames, rootListingIsBare } from './bare.js';
import { requestJson, sendJson, base64Content } from './http.js';
import { noPushAccessError } from './scopes.js';
import { ProviderError } from './types.js';
import type {
  CreateFileInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
} from './types.js';

// GitVerse's public API (gitverse.ru/docs/developers/public-api) is
// GitHub-shaped and lives on the api. subdomain of the instance. Every call
// needs the vendor Accept header; tokens authenticate as Bearer.
// Cloning works over HTTPS with per-invocation credential auth (agent-git.ts).

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

// PUT {apiBase}/repos/{full}/contents/{path}. The GitVerse API docs list a
// Gitea-style contents endpoint; the exact body shape ({message, content:
// base64, branch}) is unverified against a live instance — a failure here is
// best-effort (reported as an init warning, never fatal).
async function gitverseCreateFile(
  baseUrl: string | null | undefined,
  token: string,
  input: CreateFileInput,
): Promise<void> {
  await sendJson(
    'PUT',
    `${gitverseApiBase(baseUrl)}/repos/${input.repoFullName}/contents/${input.path}`,
    gitverseHeaders(token),
    'gitverse',
    { message: input.message, content: base64Content(input.content), branch: input.branch },
  );
}

// GitVerse's public API documents no repository-creation endpoint — the
// best-effort error tells the user to create the repo in the UI instead.
const GITVERSE_CREATE_REPO_UNSUPPORTED =
  'gitverse: repository creation via API is not supported by the public API — create the repository in the GitVerse UI';

export const gitverseApi: ProviderApi = {
  profile: (token, baseUrl) => gitverseProfile(baseUrl, token),
  listRepos: (token, baseUrl) => gitverseListRepos(baseUrl, token),
  assertPushAccess: (token, baseUrl, _tokenType, repoFullName) =>
    gitverseAssertPushAccess(baseUrl, token, repoFullName),
  createRepo: async () => {
    throw new ProviderError(GITVERSE_CREATE_REPO_UNSUPPORTED);
  },
  createFile: (token, baseUrl, _tokenType, input) =>
    gitverseCreateFile(baseUrl, token, input),
  isBare: (token, baseUrl, _tokenType, repoFullName) =>
    rootListingIsBare(
      contentsUrl(gitverseApiBase(baseUrl), repoFullName),
      gitverseHeaders(token),
      'gitverse',
    ),
  listRoot: (token, baseUrl, _tokenType, repoFullName) =>
    fetchRootEntryNames(
      contentsUrl(gitverseApiBase(baseUrl), repoFullName),
      gitverseHeaders(token),
      'gitverse',
    ),
};
