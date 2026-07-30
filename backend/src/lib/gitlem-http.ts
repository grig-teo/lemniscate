import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from './prisma.js';

// git-over-HTTP transport for the internal gitlem host. Clone/push URLs are
// <BACKEND_URL>/api/gitlem/git/<username>/<repo>.git (gitlemCloneBase()),
// authenticated with HTTP Basic — the gitlem account email (or username)
// plus its apiToken as the password, e.g.:
//
//   git clone https://you@example.com:<token>@host/api/gitlem/git/you/repo.git
//
// gitlem stores repository state as a JSON document (gitlem-store.ts), not
// a real git object database, so smart-HTTP pack negotiation cannot be
// served from it: the endpoint answers every authenticated request with a
// deterministic dumb-HTTP info response, which lets `git clone` produce a
// clear client-side error instead of hanging, while keeping one registered,
// authenticated home for the URL layout the provider client advertises.

export interface GitlemGitAuth {
  accountId: string;
  username: string;
}

/** Parse + validate the Basic credentials against GitlemUser.apiToken. */
export async function authenticateGitRequest(
  authorization: string | undefined,
): Promise<GitlemGitAuth | null> {
  if (!authorization?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator <= 0) return null;
  const login = decoded.slice(0, separator);
  const token = decoded.slice(separator + 1);
  if (!token) return null;
  const account = await prisma.gitlemUser.findUnique({ where: { apiToken: token } });
  if (!account) return null;
  if (account.email !== login && account.username !== login) return null;
  return { accountId: account.id, username: account.username };
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('WWW-Authenticate', 'Basic realm="gitlem"')
    .send({ error: 'gitlem: authentication required (Basic <email|username>:<apiToken>)' });
}

function extractService(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown> | undefined;
  const service = query?.service;
  return typeof service === 'string' ? service : null;
}

// Content-type parser for git's receive-pack stream; registered on the
// /api/gitlem/git scope so the app's JSON parser stays the global default.
export function gitPassthroughParser(
  _request: FastifyRequest,
  _payload: unknown,
  done: (err: null, body?: undefined) => void,
): void {
  done(null, undefined);
}

export function registerGitlemGitRoutes(app: FastifyInstance): void {

  app.route({
    method: ['GET', 'POST'],
    url: '/:username/:repo.git/info/refs',
    handler: gitHttpHandler,
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/:username/:repo.git/git-upload-pack',
    handler: gitHttpHandler,
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/:username/:repo.git/git-receive-pack',
    handler: gitHttpHandler,
  });
}

async function gitHttpHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = await authenticateGitRequest(request.headers.authorization);
  if (!auth) return sendUnauthorized(reply);

  const { username, repo } = request.params as { username: string; repo: string };
  if (username !== auth.username) {
    return reply.code(403).send({ error: 'gitlem: token does not own this namespace' });
  }
  const account = await prisma.gitlemUser.findUniqueOrThrow({ where: { id: auth.accountId } });
  const stored = await prisma.gitlemRepository.findUnique({
    where: { ownerId_name: { ownerId: account.id, name: repo } },
  });
  if (!stored) return reply.code(404).send({ error: 'gitlem: repository not found' });

  const service = extractService(request) ?? request.url.split('/').pop() ?? 'git-upload-pack';
  request.log.warn(
    { repo: `${username}/${repo}`, service },
    'gitlem: git protocol request on document-backed store',
  );
  return reply
    .code(501)
    .header('Content-Type', `application/x-${service}-advertisement`)
    .send(
      'gitlem stores repositories as documents; clone/push of the git pack ' +
        'protocol is not supported yet — browse files, PRs and CI runs via the API.',
    );
}
