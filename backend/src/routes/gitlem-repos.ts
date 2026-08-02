import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gitlemCloneBase } from '../lib/gitlem-accounts.js';
import {
  GITLEM_MAX_FILE_CHARS,
  addBranch,
  openPullRequest,
  parseGitlemDoc,
  pullRequestChanges,
  readFile,
  startCiRun,
  type GitlemRepoDoc,
} from '../lib/gitlem-store.js';
import { prisma } from '../lib/prisma.js';
import { authenticatedUserId } from '../plugins/auth.js';
import { parseOrReply } from './helpers.js';

// Repository-facing gitlem endpoints (session-authenticated): branch
// listing/switching, the scrollable README, open PRs, the CI/CD run trigger
// and the clone URL. Document mutations go through gitlem-store helpers
// inside a $transaction (AGENTS.md §6 — no inline doc surgery).

const nameParamsSchema = z.object({
  name: z.string().min(1).max(100),
});

const branchParamsSchema = nameParamsSchema.extend({
  branch: z.string().min(1).max(200),
});

const createBranchBodySchema = z.object({
  name: z.string().min(1).max(200),
  from: z.string().min(1).max(200).optional(),
});

const createPrBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).default(''),
  head: z.string().min(1).max(200),
  base: z.string().min(1).max(200),
});

const prParamsSchema = nameParamsSchema.extend({
  number: z.coerce.number().int().positive(),
});

interface OwnedRepo {
  id: string;
  name: string;
  defaultBranch: string;
  doc: string;
  owner: { username: string };
}

// Resolves ':name' to a repository owned by the caller's gitlem account;
// sends the 404 itself and returns null when either is missing.
async function ownedRepo(request: FastifyRequest, reply: FastifyReply): Promise<OwnedRepo | null> {
  const params = parseOrReply(nameParamsSchema, request.params, reply, 'Invalid repository name');
  if (!params) return null;
  const account = await prisma.gitlemUser.findUnique({
    where: { userId: authenticatedUserId(request) },
  });
  const repo = account
    ? await prisma.gitlemRepository.findUnique({
        where: { ownerId_name: { ownerId: account.id, name: params.name } },
        include: { owner: { select: { username: true } } },
      })
    : null;
  if (!repo) {
    void reply.code(404).send({ error: 'gitlem repository not found' });
    return null;
  }
  return repo;
}

// Read-modify-write of the repo JSON document; the callback either returns
// the response payload or sends an error reply itself and returns null.
async function mutateRepoDoc<T>(
  repo: OwnedRepo,
  reply: FastifyReply,
  mutate: (doc: GitlemRepoDoc) => T | { error: string; status: number },
): Promise<T | null> {
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.gitlemRepository.findUniqueOrThrow({ where: { id: repo.id } });
    const doc = parseGitlemDoc(current.doc);
    const outcome = mutate(doc);
    if (typeof outcome === 'object' && outcome !== null && 'error' in outcome) return outcome;
    await tx.gitlemRepository.update({
      where: { id: repo.id },
      data: { doc: JSON.stringify(doc) },
    });
    return outcome;
  });
  if (typeof result === 'object' && result !== null && 'error' in result) {
    void reply.code(result.status).send({ error: result.error });
    return null;
  }
  return result as T;
}

function readmeOf(doc: GitlemRepoDoc, branch: string): { path: string; content: string } | null {
  const file =
    readFile(doc, branch, 'README.md') ??
    doc.branches
      .find((b) => b.name === branch)
      ?.files.find((f) => /^readme(\..+)?$/i.test(f.path));
  if (!file) return null;
  return { path: file.path, content: file.content.slice(0, GITLEM_MAX_FILE_CHARS) };
}

async function detailHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const doc = parseGitlemDoc(repo.doc);
  return {
    repository: {
      name: repo.name,
      fullName: `${repo.owner.username}/${repo.name}`,
      owner: repo.owner.username,
      defaultBranch: repo.defaultBranch,
      cloneUrl: `${gitlemCloneBase()}/${repo.owner.username}/${repo.name}.git`,
      branches: doc.branches.map((branch) => branch.name),
      openPrs: doc.prs.filter((pr) => pr.state === 'open').length,
    },
  };
}

async function branchesHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const doc = parseGitlemDoc(repo.doc);
  return { defaultBranch: repo.defaultBranch, branches: doc.branches.map((b) => b.name) };
}

async function createBranchHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const body = parseOrReply(createBranchBodySchema, request.body, reply, 'Invalid branch payload');
  if (!body) return;
  const outcome = await mutateRepoDoc(repo, reply, (doc) => {
    if (!addBranch(doc, body.name, body.from ?? repo.defaultBranch)) {
      return { error: `branch ${body.name} already exists`, status: 409 };
    }
    return { name: body.name };
  });
  if (outcome) return reply.code(201).send(outcome);
}

async function readmeHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(branchParamsSchema, request.params, reply, 'Invalid branch');
  if (!params) return;
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const readme = readmeOf(parseGitlemDoc(repo.doc), params.branch);
  if (!readme) return reply.code(404).send({ error: 'No README on this branch' });
  return { branch: params.branch, ...readme };
}

async function prsHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const doc = parseGitlemDoc(repo.doc);
  const prs = doc.prs
    .filter((pr) => pr.state === 'open')
    .sort((a, b) => b.number - a.number);
  return { prs };
}

async function createPrHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const body = parseOrReply(createPrBodySchema, request.body, reply, 'Invalid pull request');
  if (!body) return;
  const outcome = await mutateRepoDoc(repo, reply, (doc) => ({ pr: openPullRequest(doc, body) }));
  if (outcome) return reply.code(201).send(outcome);
}

// Single PR (any state) plus its file-level diff — backs the standalone
// /gitlem/repos/:owner/:repo/pulls/:number page linked from task prUrls.
async function prDetailHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(prParamsSchema, request.params, reply, 'Invalid pull request number');
  if (!params) return;
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const doc = parseGitlemDoc(repo.doc);
  const pr = doc.prs.find((candidate) => candidate.number === params.number);
  const files = pr ? pullRequestChanges(doc, pr.number) : null;
  if (!pr || !files) return reply.code(404).send({ error: 'pull request not found' });
  return { pr: { ...pr, repo: `${repo.owner.username}/${repo.name}` }, files };
}

async function ciRunsHandler(request: FastifyRequest, reply: FastifyReply) {
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const doc = parseGitlemDoc(repo.doc);
  return { runs: doc.ciRuns.slice(0, 20) };
}

async function triggerCiHandler(request: FastifyRequest, reply: FastifyReply) {
  const params = parseOrReply(branchParamsSchema, request.params, reply, 'Invalid branch');
  if (!params) return;
  const repo = await ownedRepo(request, reply);
  if (!repo) return;
  const outcome = await mutateRepoDoc(repo, reply, (doc) => ({ run: startCiRun(doc, params.branch) }));
  if (outcome) return reply.code(201).send(outcome);
}

export const gitlemRepoRoutes: FastifyPluginAsync = async (app) => {
  app.get('/repos/:name', detailHandler);
  app.get('/repos/:name/branches', branchesHandler);
  app.post('/repos/:name/branches', createBranchHandler);
  app.get('/repos/:name/readme/:branch', readmeHandler);
  app.get('/repos/:name/prs', prsHandler);
  app.post('/repos/:name/prs', createPrHandler);
  app.get('/repos/:name/prs/:number', prDetailHandler);
  app.get('/repos/:name/ci-runs', ciRunsHandler);
  app.post('/repos/:name/ci/:branch', triggerCiHandler);
};
