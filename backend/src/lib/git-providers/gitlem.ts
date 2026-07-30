import { prisma } from '../prisma.js';
import { GITLEM_DEFAULT_BRANCH, parseGitlemDoc, seedGitlemDoc, upsertFile } from '../gitlem-store.js';
import { gitlemCloneBase } from '../gitlem-accounts.js';
import { ProviderError } from './types.js';
import type {
  CreateFileInput,
  CreateRepoInput,
  NormalizedRepo,
  ProviderApi,
  ProviderProfile,
} from './types.js';

// gitlem provider client (the internal minimal git host). Same ProviderApi
// contract as the REST clients, but backed by the GitlemUser /
// GitlemRepository tables — the "token" is the account's plaintext PAT
// (GitlemUser.apiToken), which also authenticates git-over-HTTP clones.
//
// fullName is '<username>/<name>', matching the clone URL layout
// <BACKEND_URL>/api/gitlem/git/<username>/<name>.git.

async function accountForToken(token: string) {
  const account = await prisma.gitlemUser.findUnique({ where: { apiToken: token } });
  if (!account) throw new ProviderError('gitlem: invalid access token', 401);
  return account;
}

function normalize(
  repo: { name: string; defaultBranch: string },
  username: string,
): NormalizedRepo {
  return {
    externalId: `${username}/${repo.name}`,
    name: repo.name,
    fullName: `${username}/${repo.name}`,
    cloneUrl: `${gitlemCloneBase()}/${username}/${repo.name}.git`,
    defaultBranch: repo.defaultBranch,
  };
}

async function findOwnedRepo(accountId: string, username: string, repoFullName: string) {
  const name = repoFullName.split('/').pop() ?? repoFullName;
  const repo = await prisma.gitlemRepository.findUnique({
    where: { ownerId_name: { ownerId: accountId, name } },
  });
  if (!repo) throw new ProviderError(`gitlem: repository ${username}/${name} not found`, 404);
  return repo;
}

export const gitlemApi: ProviderApi = {
  async profile(token): Promise<ProviderProfile> {
    const account = await accountForToken(token);
    return { username: account.username };
  },

  async listRepos(token): Promise<NormalizedRepo[]> {
    const account = await accountForToken(token);
    const repos = await prisma.gitlemRepository.findMany({
      where: { ownerId: account.id },
      orderBy: { createdAt: 'asc' },
    });
    return repos.map((repo) => normalize(repo, account.username));
  },

  // Token validity already proves ownership: gitlem repos are per-account.
  async assertPushAccess(token): Promise<void> {
    await accountForToken(token);
  },

  async createRepo(token, _baseUrl, _tokenType, input: CreateRepoInput): Promise<NormalizedRepo> {
    const account = await accountForToken(token);
    const existing = await prisma.gitlemRepository.findUnique({
      where: { ownerId_name: { ownerId: account.id, name: input.name } },
    });
    if (existing) {
      throw new ProviderError(`gitlem: repository ${input.name} already exists`, 409);
    }
    const repo = await prisma.gitlemRepository.create({
      data: {
        ownerId: account.id,
        name: input.name,
        defaultBranch: GITLEM_DEFAULT_BRANCH,
        doc: JSON.stringify(seedGitlemDoc(input.name)),
      },
    });
    return normalize(repo, account.username);
  },

  async createFile(token, _baseUrl, _tokenType, input: CreateFileInput): Promise<void> {
    const account = await accountForToken(token);
    await prisma.$transaction(async (tx) => {
      const repo = await tx.gitlemRepository.findUnique({
        where: { ownerId_name: { ownerId: account.id, name: input.repoFullName.split('/').pop()! } },
      });
      if (!repo) throw new ProviderError(`gitlem: repository ${input.repoFullName} not found`, 404);
      const doc = parseGitlemDoc(repo.doc);
      upsertFile(doc, input.branch, input.path, input.content);
      await tx.gitlemRepository.update({
        where: { id: repo.id },
        data: { doc: JSON.stringify(doc) },
      });
    });
  },

  async isBare(token, _baseUrl, _tokenType, repoFullName): Promise<boolean> {
    const account = await accountForToken(token);
    const repo = await findOwnedRepo(account.id, account.username, repoFullName);
    const doc = parseGitlemDoc(repo.doc);
    const branch = doc.branches.find((b) => b.name === repo.defaultBranch);
    const files = branch?.files ?? [];
    return files.length <= 1 && files.every((f) => /^readme(\..+)?$/i.test(f.path));
  },

  async listRoot(token, _baseUrl, _tokenType, repoFullName): Promise<string[]> {
    const account = await accountForToken(token);
    const repo = await findOwnedRepo(account.id, account.username, repoFullName);
    const doc = parseGitlemDoc(repo.doc);
    const branch = doc.branches.find((b) => b.name === repo.defaultBranch);
    const roots = new Set<string>();
    for (const file of branch?.files ?? []) {
      roots.add(file.path.split('/')[0]!);
    }
    return [...roots];
  },
};
