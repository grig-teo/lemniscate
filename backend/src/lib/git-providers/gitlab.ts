import { fetchRootEntryNames, rootListingIsBare } from './bare.js';
import { postJson, requestJson } from './http.js';
import { noPushAccessError } from './scopes.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
  ProviderTokenType,
} from './types.js';

// GitLab REST client (api/v4; self-hosted instances supported via the
// connection's baseUrl). OAuth access tokens authenticate as Bearer,
// personal access tokens via the PRIVATE-TOKEN header.

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

// GitLab exposes the root listing at /projects/{id}/repository/tree (unlike
// the GitHub-shaped providers' /repos/{full}/contents).
function gitlabTreeUrl(baseUrl: string | null | undefined, repoFullName: string): string {
  const project = encodeURIComponent(repoFullName);
  return `${gitlabApiBase(baseUrl)}/projects/${project}/repository/tree?per_page=100`;
}

interface GitlabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  default_branch: string | null;
}

function normalizeGitlabProject(project: GitlabProject): NormalizedRepo {
  return {
    externalId: String(project.id),
    name: project.path,
    fullName: project.path_with_namespace,
    cloneUrl: project.http_url_to_repo,
    defaultBranch: project.default_branch ?? 'main',
  };
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
      repos.push(normalizeGitlabProject(project));
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

async function gitlabCreateRepo(
  token: string,
  tokenType: ProviderTokenType,
  input: CreateRepoInput,
): Promise<NormalizedRepo> {
  const data = (await postJson(
    `${gitlabApiBase()}/projects`,
    gitlabHeaders(token, tokenType),
    'gitlab',
    { name: input.name, visibility: input.private ? 'private' : 'public' },
  )) as GitlabProject;
  return normalizeGitlabProject(data);
}

// POST /projects/{full}/repository/files/{path} — unlike the GitHub-shaped
// providers, GitLab takes plain (non-base64) content and a commit_message.
// Project and path are URL-encoded (slashes become %2F).
async function gitlabCreateFile(
  token: string,
  tokenType: ProviderTokenType,
  baseUrl: string | null | undefined,
  input: CreateFileInput,
): Promise<void> {
  const project = encodeURIComponent(input.repoFullName);
  const path = encodeURIComponent(input.path);
  await postJson(
    `${gitlabApiBase(baseUrl)}/projects/${project}/repository/files/${path}`,
    gitlabHeaders(token, tokenType),
    'gitlab',
    { branch: input.branch, content: input.content, commit_message: input.message },
  );
}

export const gitlabApi: ProviderApi = {
  profile: (token, _baseUrl, tokenType) => gitlabProfile(token, tokenType),
  listRepos: (token, _baseUrl, tokenType) => gitlabListRepos(token, tokenType),
  assertPushAccess: (token, _baseUrl, tokenType, repoFullName) =>
    gitlabAssertPushAccess(token, tokenType, repoFullName),
  createRepo: (token, _baseUrl, tokenType, input) => gitlabCreateRepo(token, tokenType, input),
  createFile: (token, baseUrl, tokenType, input) =>
    gitlabCreateFile(token, tokenType, baseUrl, input),
  isBare: (token, baseUrl, tokenType, repoFullName) =>
    rootListingIsBare(
      gitlabTreeUrl(baseUrl, repoFullName),
      gitlabHeaders(token, tokenType),
      'gitlab',
    ),
  listRoot: (token, baseUrl, tokenType, repoFullName) =>
    fetchRootEntryNames(
      gitlabTreeUrl(baseUrl, repoFullName),
      gitlabHeaders(token, tokenType),
      'gitlab',
    ),
};
