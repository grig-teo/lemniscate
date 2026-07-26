import { contentsUrl, fetchRootEntryNames, rootListingIsBare } from './bare.js';
import { postJson, requestJson, requestJsonMeta, sendJson, base64Content } from './http.js';
import { hasAnyScope, noPushAccessError } from './scopes.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
} from './types.js';

// GitHub REST client: repo listing, profile, push pre-flight (permissions +
// OAuth scope check), repo creation, and contents-API file commits.

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

function normalizeGithubRepo(repo: GithubRepo): NormalizedRepo {
  return {
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    defaultBranch: repo.default_branch ?? 'main',
  };
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
      repos.push(normalizeGithubRepo(repo));
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

async function githubCreateRepo(token: string, input: CreateRepoInput): Promise<NormalizedRepo> {
  const data = (await postJson(`${GITHUB_API}/user/repos`, githubHeaders(token), 'github', {
    name: input.name,
    private: input.private ?? false,
  })) as GithubRepo;
  return normalizeGithubRepo(data);
}

// PUT /repos/{full}/contents/{path} — creates the file on the given branch
// (also the first commit of an empty repository).
async function githubCreateFile(token: string, input: CreateFileInput): Promise<void> {
  await sendJson(
    'PUT',
    `${GITHUB_API}/repos/${input.repoFullName}/contents/${input.path}`,
    githubHeaders(token),
    'github',
    { message: input.message, content: base64Content(input.content), branch: input.branch },
  );
}

export const githubApi: ProviderApi = {
  profile: (token) => githubProfile(token),
  listRepos: (token) => githubListRepos(token),
  assertPushAccess: (token, _baseUrl, _tokenType, repoFullName) =>
    githubAssertPushAccess(token, repoFullName),
  createRepo: (token, _baseUrl, _tokenType, input) => githubCreateRepo(token, input),
  createFile: (token, _baseUrl, _tokenType, input) => githubCreateFile(token, input),
  isBare: (token, _baseUrl, _tokenType, repoFullName) =>
    rootListingIsBare(contentsUrl(GITHUB_API, repoFullName), githubHeaders(token), 'github'),
  listRoot: (token, _baseUrl, _tokenType, repoFullName) =>
    fetchRootEntryNames(contentsUrl(GITHUB_API, repoFullName), githubHeaders(token), 'github'),
};
