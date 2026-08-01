// Shared types for the per-provider REST clients (git-providers/github.ts,
// gitlab.ts, gitverse.ts, gitee.ts). Each client talks to the git host's API
// with the connection's decrypted access token and returns normalized shapes
// so routes and the agent worker never deal with provider-specific payloads.

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

export interface CreateRepoInput {
  name: string;
  private?: boolean;
}

// One file committed to a repository (used to initialize freshly created
// repos with README.md / AGENTS.md). `content` is the plain UTF-8 text;
// providers that want base64 get it encoded by their implementation.
export interface CreateFileInput {
  repoFullName: string;
  path: string;
  content: string;
  message: string;
  branch: string;
}

export interface ProviderProfile {
  username: string;
}

export interface GitProviderClient {
  listRepos(): Promise<NormalizedRepo[]>;
  createRepo(input: CreateRepoInput): Promise<NormalizedRepo>;
  createFile(input: CreateFileInput): Promise<void>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestResult>;
  isBare(repoFullName: string): Promise<boolean>;
  /** Root-level entry names (files and dirs) — feeds bare/platform detection. */
  listRootEntries(repoFullName: string): Promise<string[]>;
}

export type ProviderName = 'github' | 'gitverse' | 'gitlab' | 'gitee' | 'gitlem';

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

// The uniform shape every provider module implements; the registry in
// git-providers.ts is the ONE place a provider is selected (AGENTS.md §4).
export interface ProviderApi {
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
  createRepo(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
    input: CreateRepoInput,
  ): Promise<NormalizedRepo>;
  createFile(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
    input: CreateFileInput,
  ): Promise<void>;
  isBare(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
    repoFullName: string,
  ): Promise<boolean>;
  listRoot(
    token: string,
    baseUrl: string | null | undefined,
    tokenType: ProviderTokenType,
    repoFullName: string,
  ): Promise<string[]>;
}
