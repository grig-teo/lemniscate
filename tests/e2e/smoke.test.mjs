// E2E smoke suite — run.sh executes these tests in a throwaway container on
// the compose network (tests/e2e/testrunner/Dockerfile), against the real
// stack reached via internal service URLs (http://backend:3000 etc.). Covers
// the product's first-run path end to end:
//
//   health/readiness (Postgres + Redis + MinIO via /health/ready)
//   -> PAT connect (login) against the stub git provider
//   -> repository sync from the provider API
//   -> LLM config creation (secret encryption path)
//   -> task create -> BullMQ job -> worker clone/LLM/commit/push
//   -> status transitions queued -> running -> done
//   -> task console contains the stub LLM's summary
//   -> the task branch (with the stub's file) landed on the git remote
//
// The only credentials are throwaway e2e values; the gitstub TLS cert is a
// self-signed one generated at image build. Node's built-in test runner, no
// dependencies.

import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCb);

const BACKEND_URL = process.env.E2E_BACKEND_URL;
const WORKER_HEALTH_URL = process.env.E2E_WORKER_HEALTH_URL;
const FRONTEND_URL = process.env.E2E_FRONTEND_URL;
const GITSTUB_URL = process.env.E2E_GITSTUB_URL;
const SEED = JSON.parse(process.env.E2E_SEED ?? '{}');
const TASK_TIMEOUT_MS = Number(process.env.E2E_TASK_TIMEOUT_SECONDS ?? 300) * 1000;

const EXPECTED_BRANCH = 'lemniscate/e2e-smoke';
const EXPECTED_SUMMARY = 'Stub LLM applied the e2e smoke change';
const PAT_TOKEN = 'e2e-pat-token';

assert.ok(BACKEND_URL && WORKER_HEALTH_URL && FRONTEND_URL && GITSTUB_URL, 'E2E_*_URL env vars are required');
assert.ok(SEED.userId && SEED.connectionId, 'E2E_SEED must carry userId and connectionId');

// Session cookie captured by the PAT-connect test and reused after.
let authCookie = null;
let repository = null;
let task = null;

async function api(method, pathName, { body, cookie } = {}) {
  const response = await fetch(`${BACKEND_URL}/api${pathName}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie: authCookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page; the status assertion will report it
  }
  return { status: response.status, json, headers: response.headers, text };
}

function extractSessionCookie(headers) {
  const cookies = headers.getSetCookie();
  const session = cookies.find((line) => line.startsWith('lemniscate_token='));
  assert.ok(session, `expected a lemniscate_token cookie, got: ${cookies.join(', ')}`);
  return session.split(';')[0];
}

async function waitForTaskTerminal() {
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  const terminal = new Set(['done', 'failed', 'closed', 'cancelled', 'awaiting_review']);
  for (;;) {
    const { status, json } = await api('GET', `/tasks/${task.id}`, { cookie: true });
    assert.equal(status, 200, `GET /tasks/:id -> ${status}`);
    if (terminal.has(json.task.status)) return json.task;
    assert.ok(Date.now() < deadline, `task did not reach a terminal state within ${TASK_TIMEOUT_MS}ms (last: ${json.task.status})`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function git(args, options = {}) {
  const { stdout } = await execFile('git', args, {
    ...options,
    env: { ...process.env, GIT_SSL_NO_VERIFY: 'true', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

test('stack boots healthy: backend readiness reports postgres+redis', async () => {
  const ready = await fetch(`${BACKEND_URL}/health/ready`);
  assert.equal(ready.status, 200);
  const body = await ready.json();
  assert.equal(body.ok, true);
  assert.equal(body.postgres, true);
  assert.equal(body.redis, true);

  const workerReady = await fetch(`${WORKER_HEALTH_URL}/health/ready`);
  assert.equal(workerReady.status, 200);
  assert.equal((await workerReady.json()).ok, true);

  const frontend = await fetch(`${FRONTEND_URL}/`);
  assert.equal(frontend.status, 200);
  assert.match(await frontend.text(), /<html/i);
});

test('unauthenticated API calls are rejected', async () => {
  const me = await api('GET', '/auth/me');
  assert.equal(me.status, 401);
  const tasks = await api('GET', '/tasks');
  assert.equal(tasks.status, 401);
});

test('PAT connect logs in (session cookie) and syncs the repository', async () => {
  const connect = await api('POST', '/connections', {
    body: { provider: 'gitverse', token: PAT_TOKEN, baseUrl: 'https://gitstub' },
  });
  assert.equal(connect.status, 200, `PAT connect failed: ${connect.text}`);
  assert.equal(connect.json.connection.username, 'e2e-user');
  authCookie = extractSessionCookie(connect.headers);

  const repos = await api('GET', '/repositories', { cookie: true });
  assert.equal(repos.status, 200);
  repository = repos.json.repositories.find((repo) => repo.fullName === 'e2e-user/e2e-repo');
  assert.ok(repository, 'synced repository e2e-user/e2e-repo not found');
  assert.equal(repository.cloneUrl, 'https://gitstub/e2e-repo.git');
  assert.equal(repository.defaultBranch, 'main');
});

test('LLM config can be created against the stub endpoint', async () => {
  const created = await api('POST', '/llm-configs', {
    cookie: true,
    body: {
      name: 'e2e-stub',
      baseUrl: 'http://gitstub:8081/v1',
      apiKey: 'e2e-llm-key',
      model: 'stub-model',
      maxTokens: 4096,
      contextWindow: 8192,
      requestsPerMinute: 600,
      isDefault: true,
    },
  });
  assert.equal(created.status, 201, `LLM config create failed: ${created.text}`);
  assert.equal(created.json.hasApiKey, true);
});

test('full task lifecycle: queued -> running -> done with a pushed branch', async (t) => {
  // The smoke loop asserts branch+push, not PR creation (the stub provider
  // implements no PR endpoint) — disable auto-PR on the repository first.
  const patched = await api('PATCH', `/repositories/${repository.id}`, {
    cookie: true,
    body: { autoCreatePr: false },
  });
  assert.equal(patched.status, 200, `repo PATCH failed: ${patched.text}`);
  assert.equal(patched.json.repository.autoCreatePr, false);

  const created = await api('POST', '/tasks', {
    cookie: true,
    body: { repositoryId: repository.id, prompt: 'Add the e2e smoke marker file.' },
  });
  assert.equal(created.status, 201, `task create failed: ${created.text}`);
  task = created.json.task;
  assert.equal(task.status, 'queued');

  const final = await waitForTaskTerminal();
  assert.equal(final.status, 'done', `task ended as ${final.status}: ${final.error ?? ''}`);
  assert.equal(final.branchName, EXPECTED_BRANCH);

  const eventsResponse = await api('GET', `/tasks/${task.id}/events`, { cookie: true });
  assert.equal(eventsResponse.status, 200);
  const events = eventsResponse.json;

  // The stub run's 'running' phase is shorter than any sane poll interval,
  // so verify the queued -> running -> done transition from the persisted
  // status events (setTaskStatus appends one per transition) instead of
  // live polling. 'queued' is the create-time status, asserted above.
  const transitions = events
    .filter((event) => event.kind === 'status')
    .map((event) => event.payload.status);
  assert.deepEqual(transitions, ['running', 'done'], `status events: ${transitions.join(', ')}`);

  await t.test('task console shows the stub LLM output', async () => {
    const lines = events
      .filter((event) => event.kind === 'log')
      .map((event) => event.payload.line);
    assert.ok(
      lines.some((line) => line.includes(`LLM proposed 1 change(s): ${EXPECTED_SUMMARY}`)),
      `console missing stub summary; lines:\n${lines.join('\n')}`,
    );
    assert.ok(
      lines.some((line) => line.includes(`pushed branch ${EXPECTED_BRANCH}`)),
      `console missing push confirmation; lines:\n${lines.join('\n')}`,
    );
  });

  await t.test('the task branch with the stub file is on the git remote', async () => {
    const remote = `${GITSTUB_URL}/e2e-repo.git`;
    const refs = await git(['ls-remote', remote, `refs/heads/${EXPECTED_BRANCH}`]);
    assert.match(refs, new RegExp(`refs/heads/${EXPECTED_BRANCH}$`, 'm'));

    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-clone-'));
    await git(['clone', '--branch', EXPECTED_BRANCH, '--depth', '1', remote, dir]);
    const marker = readFileSync(path.join(dir, 'E2E_SMOKE.md'), 'utf8');
    assert.match(marker, /Written by the stub LLM during the e2e smoke run/);
  });
});
