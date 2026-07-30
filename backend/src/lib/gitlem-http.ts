import { execFile } from 'node:child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { materializeGitlemRepo } from './gitlem-clone.js';
import { prisma } from './prisma.js';

// git-over-HTTP transport for the internal gitlem host. Clone URLs are
// <BACKEND_URL>/api/gitlem/git/<username>/<repo>.git (gitlemCloneBase()),
// authenticated with HTTP Basic — the gitlem account email (or username)
// plus its apiToken as the password, e.g.:
//
//   git clone https://you@example.com:<token>@host/api/gitlem/git/you/repo.git
//
// gitlem stores repository state as a JSON document (gitlem-store.ts); on
// the first fetch the document is materialized into a real git repository
// on disk (gitlem-clone.ts) and the request is proxied to
// `git http-backend` (smart HTTP, read-only — receive-pack is disabled on
// the materialized clone).

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

// Content-type parser for git's upload-pack request stream; registered on
// the /api/gitlem/git scope so the app's JSON parser stays the global
// default. Buffers the raw body for http-backend's stdin.
export function gitPassthroughParser(
  _request: FastifyRequest,
  payload: NodeJS.ReadableStream,
  done: (err: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  payload.on('data', (chunk: Buffer) => chunks.push(chunk));
  payload.on('end', () => done(null, Buffer.concat(chunks)));
  payload.on('error', done);
}

export function registerGitlemGitRoutes(app: FastifyInstance): void {
  app.route({
    method: ['GET', 'POST'],
    url: '/:username/:repo.git/*',
    handler: gitHttpHandler,
  });
  app.route({
    method: ['GET', 'POST'],
    url: '/:username/:repo.git',
    handler: gitHttpHandler,
  });
}

interface GitParams {
  username: string;
  repo: string;
  '*': string;
}

function httpBackendEnv(request: FastifyRequest, params: GitParams, gitDir: string, body?: Buffer) {
  const queryIndex = request.url.indexOf('?');
  return {
    ...process.env,
    GIT_PROJECT_ROOT: gitDir,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: request.method,
    PATH_INFO: `/${params.username}/${params.repo}.git/${params['*'] ?? ''}`,
    QUERY_STRING: queryIndex >= 0 ? request.url.slice(queryIndex + 1) : '',
    CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
    CONTENT_LENGTH: body ? String(body.length) : '',
  };
}

function sendCgiResponse(
  reply: FastifyReply,
  stdout: string,
  stderr: string,
): FastifyReply {
  const headEnd = stdout.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    return reply.code(502).send({ error: `gitlem: git http-backend failed: ${stderr}` });
  }
  const head = stdout.slice(0, headEnd);
  const body = Buffer.from(stdout.slice(headEnd + 4), 'binary');
  for (const line of head.split('\r\n')) {
    const [name, ...rest] = line.split(':');
    if (!name || rest.length === 0) continue;
    if (name.trim().toLowerCase() === 'status') {
      void reply.code(Number(rest.join(':').trim().split(' ')[0]) || 200);
    } else {
      void reply.header(name.trim(), rest.join(':').trim());
    }
  }
  return reply.send(body);
}

/** Proxy one git smart-HTTP request to `git http-backend`. */
export async function runHttpBackend(
  request: FastifyRequest,
  reply: FastifyReply,
  params: GitParams,
  gitDir: string,
): Promise<FastifyReply> {
  const body = request.method === 'POST' ? (request.body as Buffer | undefined) : undefined;
  const env = httpBackendEnv(request, params, gitDir, body);
  return new Promise<FastifyReply>((resolve) => {
    const child = execFile(
      'git',
      ['http-backend'],
      { env, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err && !stdout?.length) {
          void reply.code(502).send({ error: `gitlem: git http-backend failed: ${stderr}` });
          resolve(reply);
          return;
        }
        sendCgiResponse(reply, stdout.toString('binary'), stderr.toString());
        resolve(reply);
      },
    );
    if (body?.length) child.stdin?.write(body);
    child.stdin?.end();
  });
}

async function gitHttpHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = await authenticateGitRequest(request.headers.authorization);
  if (!auth) return sendUnauthorized(reply);

  const params = request.params as GitParams;
  if (params.username !== auth.username) {
    return reply.code(403).send({ error: 'gitlem: token does not own this namespace' });
  }
  const gitDir = await materializeGitlemRepo(params.username, params.repo);
  if (!gitDir) return reply.code(404).send({ error: 'gitlem: repository not found' });
  return runHttpBackend(request, reply, params, gitDir);
}
