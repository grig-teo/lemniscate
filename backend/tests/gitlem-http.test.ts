import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Behavior tests for the git-over-HTTP transport: a smart-HTTP request is
// proxied to a real `git http-backend` spawned against the materialized
// clone, so these tests lock the CGI env mapping (GIT_PROJECT_ROOT vs
// PATH_INFO), the auth gate, the request-body cap, and the failure handling
// of the backend child process.

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  repoFindUnique: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitlemUser: { findUnique: mocks.userFindUnique },
    gitlemRepository: { findUnique: mocks.repoFindUnique },
  },
}));

// Default-passthrough execFile mock: gitlem-clone promisifies execFile via
// util.promisify.custom, so repo materialization keeps spawning real git;
// tests can queue mockImplementationOnce to intercept runHttpBackend's
// direct execFile('git', ['http-backend']) call.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  mocks.execFile.mockImplementation((...args: unknown[]) =>
    (actual.execFile as (...a: unknown[]) => unknown)(...args),
  );
  Object.assign(mocks.execFile, { [promisify.custom]: promisify(actual.execFile) });
  return { ...actual, execFile: mocks.execFile };
});

import { gitPassthroughParser, registerGitlemGitRoutes } from '../src/lib/gitlem-http.js';
import { materializeGitlemRepo, resetGitlemCloneCache } from '../src/lib/gitlem-clone.js';

const DOC = JSON.stringify({
  branches: [{ name: 'main', files: [{ path: 'README.md', content: '# demo\n' }] }],
  prs: [],
  ciRuns: [],
  nextPrNumber: 1,
  nextRunId: 1,
});

const AUTH = `Basic ${Buffer.from('alice:tok').toString('base64')}`;

function mockRepo(doc: string = DOC) {
  mocks.userFindUnique.mockResolvedValue({
    id: 'gu-1',
    username: 'alice',
    email: 'alice@example.com',
    apiToken: 'tok',
  });
  mocks.repoFindUnique.mockResolvedValue({ id: 'r-1', doc, defaultBranch: 'main' });
}

function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser('*', gitPassthroughParser);
  registerGitlemGitRoutes(app);
  return app;
}

describe('git smart-HTTP transport', () => {
  const materialized: string[] = [];

  afterEach(async () => {
    resetGitlemCloneCache();
    mocks.execFile.mockClear();
    for (const dir of materialized.splice(0)) {
      await rm(dirname(dir), { recursive: true, force: true });
    }
  });

  it('serves the git-upload-pack advertisement for a materialized repo', async () => {
    mockRepo();
    const gitDir = await materializeGitlemRepo('alice', 'demo');
    materialized.push(gitDir!);

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/demo.git/info/refs?service=git-upload-pack',
      headers: { authorization: AUTH },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('git-upload-pack-advertisement');
    expect(response.body).toContain('refs/heads/main');
  });

  it('advertises git-receive-pack so authenticated owners can push', async () => {
    mockRepo();
    const gitDir = await materializeGitlemRepo('alice', 'demo');
    materialized.push(gitDir!);

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/demo.git/info/refs?service=git-receive-pack',
      headers: { authorization: AUTH },
    });
    // receive-pack is enabled on the materialized bare repo (gitlem-clone.ts),
    // so the advertisement returns 200 — without it `git push` 403s.
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('git-receive-pack-advertisement');
  });

  it('rejects requests without valid Basic credentials', async () => {
    mockRepo();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/demo.git/info/refs?service=git-upload-pack',
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Basic');
  });

  it('forbids tokens outside their own namespace', async () => {
    mockRepo();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/bob/demo.git/info/refs?service=git-upload-pack',
      headers: { authorization: AUTH },
    });
    expect(response.statusCode).toBe(403);
  });

  it('serves repos whose name needs URL-encoding (the clone URL encodes it)', async () => {
    mockRepo();
    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/test%203.git/info/refs?service=git-upload-pack',
      headers: { authorization: AUTH },
    });
    expect(mocks.repoFindUnique).toHaveBeenCalledWith({
      where: { ownerId_name: { ownerId: 'gu-1', name: 'test 3' } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('refs/heads/main');
    const gitDir = await materializeGitlemRepo('alice', 'test 3');
    materialized.push(gitDir!);
  });

  it('answers 502 with the reason when materialization throws', async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: 'gu-1',
      username: 'alice',
      email: 'alice@example.com',
      apiToken: 'tok',
    });
    mocks.repoFindUnique.mockRejectedValue(new Error('db exploded'));

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/demo.git/info/refs?service=git-upload-pack',
      headers: { authorization: AUTH },
    });
    // Without the handler's error boundary Fastify's default 500 surfaces as
    // an opaque proxy 502; the explicit 502 makes the failure diagnosable
    // (the detail goes to the request log, not the git client).
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain('failed to materialize');
  });

  it('fails with 502 instead of serving truncated http-backend output', async () => {
    mockRepo();
    const gitDir = await materializeGitlemRepo('alice', 'demo');
    materialized.push(gitDir!);

    mocks.execFile.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      const err = Object.assign(new Error('stdout maxBuffer exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      callback(
        err,
        Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\npartial'),
        Buffer.alloc(0),
      );
      return { stdin: { write() {}, end() {} } };
    });

    const app = buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/alice/demo.git/info/refs?service=git-upload-pack',
      headers: { authorization: AUTH },
    });
    expect(response.statusCode).toBe(502);
  });
});

describe('gitPassthroughParser', () => {
  it('passes small bodies through unchanged', async () => {
    const payload = Readable.from([Buffer.from('hello '), Buffer.from('git')]);
    const body = await new Promise<Buffer>((resolve, reject) => {
      gitPassthroughParser({} as never, payload, (err, buffered) => {
        if (err) reject(err);
        else resolve(buffered!);
      });
    });
    expect(body.toString()).toBe('hello git');
  });

  it('aborts once the body grows past the 25MB cap, exactly once', async () => {
    const payload = new Readable({ read() {} });
    let calls = 0;
    let error: Error | null = null;
    gitPassthroughParser({} as never, payload, (err) => {
      calls += 1;
      error = err;
    });
    payload.push(Buffer.alloc(26 * 1024 * 1024));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(error).toBeTruthy();
    expect((error as unknown as { statusCode?: number }).statusCode).toBe(413);

    payload.push(Buffer.from('late'));
    payload.push(null);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
  });
});
