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
// default. Buffers the raw body for http-backend's stdin. Fastify's
// bodyLimit does not apply to custom content parsers, so the cap is
// enforced here: past MAX_BODY_BYTES the request is aborted with 413.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

export function gitPassthroughParser(
  _request: FastifyRequest,
  payload: NodeJS.ReadableStream,
  done: (err: Error | null, body?: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    done(err);
    (payload as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  };
  payload.on('data', (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('gitlem: git request body exceeds the 25MB limit') as Error & {
        statusCode?: number;
      };
      err.statusCode = 413;
      fail(err);
      return;
    }
    chunks.push(chunk);
  });
  payload.on('end', () => {
    if (settled) return;
    settled = true;
    done(null, Buffer.concat(chunks));
  });
  payload.on('error', fail);
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
    // GIT_PROJECT_ROOT already points at the materialized bare repo, so
    // PATH_INFO must be only the part after '.git' — http-backend
    // concatenates the two and would 404 on '<root>/<user>/<repo>.git/...'.
    PATH_INFO: `/${params['*'] ?? ''}`,
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
        // A maxBuffer hit means stdout is truncated — never parse it as a
        // complete CGI response; fail the request instead.
        const truncated =
          (err as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        if (truncated || (err && !stdout?.length)) {
          const detail = stderr?.length ? stderr : err?.message;
          void reply.code(502).send({ error: `gitlem: git http-backend failed: ${detail}` });
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

// Materialization failure boundary: a throw here (doc parse, a failed git
// subprocess while building the clone) must not fall through to Fastify's
// default 500 — the reverse proxy reports that to the git client as an
// opaque 502 with no diagnosable body (observed on clones of repos with
// URL-encoded names). Answer 502 with the reason instead.
async function gitHttpHandler(request: FastifyRequest, reply: FastifyReply) {
  const auth = await authenticateGitRequest(request.headers.authorization);
  if (!auth) return sendUnauthorized(reply);

  const params = request.params as GitParams;
  if (params.username !== auth.username) {
    return reply.code(403).send({ error: 'gitlem: token does not own this namespace' });
  }
  const gitDir = await tryMaterialize(request, params);
  if (gitDir === undefined) {
    return reply.code(502).send({ error: 'gitlem: failed to materialize the repository' });
  }
  if (gitDir === null) return reply.code(404).send({ error: 'gitlem: repository not found' });
  return runHttpBackend(request, reply, params, gitDir);
}

/** undefined = materialization threw (already logged); null = repo missing. */
async function tryMaterialize(
  request: FastifyRequest,
  params: GitParams,
): Promise<string | null | undefined> {
  try {
    return await materializeGitlemRepo(params.username, params.repo);
  } catch (err) {
    request.log.error({ err }, 'gitlem: repository materialization failed');
    return undefined;
  }
}
