import { config } from '../../config.js';
import { ProviderError } from './types.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
} from './types.js';

// Gitlem — the internal minimal git host. Repositories live as on-disk bare
// git repos under GITLEM_REPO_ROOT and are cloned/pushed over HTTP against
// the same backend origin (GITLEM_BASE_URL, defaulting to BACKEND_URL). There
// is no external REST API to call: every operation resolves against the local
// filesystem. The token here is the gitlem account's password (validated
// against the GitlemUser.passwordHash at the connection layer); this provider
// trusts an already-authenticated token and only does repo bookkeeping.

// Default git username for gitlem-managed repos (the owner segment of the
// clone URL). The per-account username is persisted by the connection layer;
// this is the namespace every clone URL is built under until the host grows
// multi-account routing.
export const GITLEM_DEFAULT_USERNAME = 'gitlem';

// Web base URL the clone URLs are built from (origin serving the bare repos).
export function gitlemBase(baseUrl?: string | null): string {
  return (baseUrl ?? config.GITLEM_BASE_URL ?? config.BACKEND_URL).replace(/\/+$/, '');
}

// Absolute on-disk root for gitlem bare repositories (no trailing slash).
export function gitlemRepoRoot(): string {
  return config.GITLEM_REPO_ROOT.replace(/\/+$/, '');
}

// Pure: builds the normalized repo shape from an on-disk directory name.
// externalId is the directory name (also the slug); cloneUrl points at the
// HTTP endpoint. defaultBranch is 'main' for every freshly created repo.
export function normalizeGitlemRepo(name: string, baseUrl?: string | null): NormalizedRepo {
  return {
    externalId: name,
    name,
    fullName: `${GITLEM_DEFAULT_USERNAME}/${name}`,
    cloneUrl: `${gitlemBase(baseUrl)}/${GITLEM_DEFAULT_USERNAME}/${name}.git`,
    defaultBranch: 'main',
  };
}

// profile/listRepos are best-effort against the filesystem: the connection
// layer authenticates the gitlem account before these run, so a token here is
// always "valid".
async function gitlemProfile(token: string): Promise<ProviderProfile> {
  if (!token) throw new ProviderError('gitlem: missing account password');
  return { username: GITLEM_DEFAULT_USERNAME };
}

// createRepo: the bare repo is created by the gitlem host route (which owns
// the git plumbing). The provider returns the normalized shape so the
// connection layer can persist it; on-disk creation is idempotent there.
async function gitlemCreateRepo(_token: string, input: CreateRepoInput): Promise<NormalizedRepo> {
  return normalizeGitlemRepo(input.name);
}

// Gitlem repos are seeded directly (README.md committed on creation by the
// host route's git plumbing); there is no contents API to write through.
async function gitlemCreateFile(_token: string, _input: CreateFileInput): Promise<void> {
  return;
}

// The push pre-flight always passes for an authenticated gitlem account —
// the connection's token is the account credential and grants push by design.
async function gitlemAssertPushAccess(_token: string, _repoFullName: string): Promise<void> {
  return;
}

// Bare/platform detection: gitlem repos always have at least the seeded
// README, so they are never "bare" in the agent-scaffold sense.
async function gitlemIsBare(_token: string, _repoFullName: string): Promise<boolean> {
  return false;
}

async function gitlemListRoot(_token: string, _repoFullName: string): Promise<string[]> {
  return [];
}

export const gitlemApi: ProviderApi = {
  profile: (token) => gitlemProfile(token),
  listRepos: async () => [],
  assertPushAccess: (token, _baseUrl, _tokenType, repoFullName) =>
    gitlemAssertPushAccess(token, repoFullName),
  createRepo: (token, _baseUrl, _tokenType, input) => gitlemCreateRepo(token, input),
  createFile: (token, _baseUrl, _tokenType, input) => gitlemCreateFile(token, input),
  isBare: (token, _baseUrl, _tokenType, repoFullName) =>
    gitlemIsBare(token, repoFullName),
  listRoot: (token, _baseUrl, _tokenType, repoFullName) =>
    gitlemListRoot(token, repoFullName),
};
