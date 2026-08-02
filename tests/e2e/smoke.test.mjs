// E2E smoke suite — run.sh executes these tests in a throwaway container on
// the compose network (tests/e2e/testrunner/Dockerfile), against the real
// stack reached via internal service URLs (http://backend:3000 etc.) and a
// REAL git server (Gitea) behind the gitstub TLS edge. Covers the product's
// core value chain end to end:
//
//   health/readiness (Postgres + Redis + MinIO via /health/ready)
//   -> PAT connect (login) against Gitea (GitVerse provider path)
//   -> repository sync from Gitea's API
//   -> LLM config creation (secret encryption path) against the mock LLM
//   -> task create -> BullMQ job -> worker clone/LLM/commit/push
//   -> status transitions queued -> running -> awaiting_review
//   -> task console contains the mock LLM's summary + PR-open line
//   -> the task branch (with the mock's file) landed on Gitea
//   -> the pull request exists on Gitea (asserted via its API + web URL)
//   -> token usage recorded (task DTO + GET /api/usage)
//   -> "PR opened" notification recorded (GET /api/notifications)
//   -> human PR review comment (posted via the Gitea API as a second user,
//      repo autoAddressReview flag on) -> pr-state-sync poll fallback ->
//      address-review job -> follow-up commit on the agent branch + task
//      events summarizing the change + "review addressed" notification
//   -> Prometheus series present (worker /metrics, backend /metrics guard)
//
// The only credentials are throwaway e2e values minted by run.sh; the
// gitstub TLS cert is a self-signed one generated at image build (the runner
// runs with NODE_TLS_REJECT_UNAUTHORIZED=0). Node's built-in test runner,
// no dependencies.

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
const GITSTUB_API_URL = process.env.E2E_GITSTUB_API_URL;
const PAT_TOKEN = process.env.E2E_PAT;
const REVIEWER_PAT = process.env.E2E_REVIEWER_PAT;
const METRICS_TOKEN = process.env.E2E_METRICS_TOKEN;
const SEED = JSON.parse(process.env.E2E_SEED ?? '{}');
const TASK_TIMEOUT_MS = Number(process.env.E2E_TASK_TIMEOUT_SECONDS ?? 300) * 1000;
const REVIEW_TIMEOUT_MS = Number(process.env.E2E_REVIEW_TIMEOUT_SECONDS ?? 180) * 1000;

const REPO_FULL_NAME = 'e2e-user/e2e-repo';
const CLONE_URL = `${GITSTUB_URL}/${REPO_FULL_NAME}.git`;
const EXPECTED_BRANCH = 'lemniscate/e2e-smoke';
const EXPECTED_MARKER = 'E2E_SMOKE.md';
const EXPECTED_PR_URL = `${GITSTUB_URL}/${REPO_FULL_NAME}/pulls/1`;

assert.ok(BACKEND_URL && WORKER_HEALTH_URL && FRONTEND_URL && GITSTUB_URL && GITSTUB_API_URL, 'E2E_*_URL env vars are required');
assert.ok(PAT_TOKEN && REVIEWER_PAT && METRICS_TOKEN, 'E2E_PAT, E2E_REVIEWER_PAT and E2E_METRICS_TOKEN are required');
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

// Gitea REST API through the TLS edge — the same base the backend's GitVerse
// client talks to. Auth: a seeded PAT, exactly like the backend does.
async function giteaSend(method, pathName, { body, token } = {}) {
  const response = await fetch(`${GITSTUB_API_URL}${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${token ?? PAT_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(
    response.status >= 200 && response.status < 300,
    `gitea ${method} ${pathName} -> ${response.status}: ${text.slice(0, 200)}`,
  );
  return text ? JSON.parse(text) : null;
}

async function giteaApi(pathName) {
  return giteaSend('GET', pathName);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    body: { provider: 'gitverse', token: PAT_TOKEN, baseUrl: GITSTUB_URL },
  });
  assert.equal(connect.status, 200, `PAT connect failed: ${connect.text}`);
  assert.equal(connect.json.connection.username, 'e2e-user');
  authCookie = extractSessionCookie(connect.headers);

  const repos = await api('GET', '/repositories', { cookie: true });
  assert.equal(repos.status, 200);
  repository = repos.json.repositories.find((repo) => repo.fullName === REPO_FULL_NAME);
  assert.ok(repository, `synced repository ${REPO_FULL_NAME} not found`);
  assert.equal(repository.cloneUrl, CLONE_URL);
  assert.equal(repository.defaultBranch, 'main');
  // PR creation must stay enabled: it is the product default and the whole
  // point of this suite — the lifecycle test below asserts the opened PR.
  assert.equal(repository.autoCreatePr, true);
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

test('full task lifecycle: queued -> running -> awaiting_review with an asserted PR', async (t) => {
  const created = await api('POST', '/tasks', {
    cookie: true,
    body: { repositoryId: repository.id, prompt: 'Add the e2e smoke marker file.' },
  });
  assert.equal(created.status, 201, `task create failed: ${created.text}`);
  task = created.json.task;
  assert.equal(task.status, 'queued');

  const final = await waitForTaskTerminal();
  assert.equal(final.status, 'awaiting_review', `task ended as ${final.status}: ${final.error ?? ''}`);
  assert.equal(final.branchName, EXPECTED_BRANCH);
  assert.equal(final.prUrl, EXPECTED_PR_URL);

  const eventsResponse = await api('GET', `/tasks/${task.id}/events`, { cookie: true });
  assert.equal(eventsResponse.status, 200);
  const events = eventsResponse.json;

  // The stub run's 'running' phase is shorter than any sane poll interval,
  // so verify the queued -> running -> awaiting_review transition from the
  // persisted status events (setTaskStatus appends one per transition)
  // instead of live polling. 'queued' is the create-time status, asserted
  // above.
  const transitions = events
    .filter((event) => event.kind === 'status')
    .map((event) => event.payload.status);
  assert.deepEqual(transitions, ['running', 'awaiting_review'], `status events: ${transitions.join(', ')}`);

  await t.test('task console shows the stub LLM output and the PR-open line', async () => {
    const lines = events
      .filter((event) => event.kind === 'log')
      .map((event) => event.payload.line);
    // lemcore emits structured agent_step events: the write_file tool call
    // for the marker file is the stub LLM's visible output.
    const steps = events.filter((event) => event.kind === 'agent_step');
    assert.ok(
      steps.some(
        (event) =>
          event.payload?.tool === 'write_file' &&
          typeof event.payload?.title === 'string' &&
          event.payload.title.includes(EXPECTED_MARKER),
      ),
      `console missing the write_file(${EXPECTED_MARKER}) step; steps:\n${steps.map((s) => s.payload?.title).join('\n')}`,
    );
    assert.ok(
      lines.some((line) => line.includes(`pushed branch ${EXPECTED_BRANCH}`)),
      `console missing push confirmation; lines:\n${lines.join('\n')}`,
    );
    assert.ok(
      lines.some((line) => line.includes(`opened pull request: ${EXPECTED_PR_URL}`)),
      `console missing PR-open confirmation; lines:\n${lines.join('\n')}`,
    );
  });

  await t.test('the task branch with the stub file is on the git remote', async () => {
    const refs = await git(['ls-remote', CLONE_URL, `refs/heads/${EXPECTED_BRANCH}`]);
    assert.match(refs, new RegExp(`refs/heads/${EXPECTED_BRANCH}$`, 'm'));

    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-clone-'));
    await git(['clone', '--branch', EXPECTED_BRANCH, '--depth', '1', CLONE_URL, dir]);
    const marker = readFileSync(path.join(dir, 'E2E_SMOKE.md'), 'utf8');
    assert.match(marker, /Written by the stub LLM during the e2e smoke run/);
  });

  await t.test('the pull request exists on the git host', async () => {
    const open = await giteaApi(
      `/repos/${REPO_FULL_NAME}/pulls?state=open&head=${encodeURIComponent(EXPECTED_BRANCH)}&per_page=100`,
    );
    const pull = open.find((candidate) => candidate.head.ref === EXPECTED_BRANCH);
    assert.ok(pull, `no open PR for ${EXPECTED_BRANCH} on Gitea: ${JSON.stringify(open)}`);
    assert.equal(pull.base.ref, 'main');
    assert.equal(pull.title, task.title);
    assert.equal(pull.html_url, EXPECTED_PR_URL);

    const detail = await giteaApi(`/repos/${REPO_FULL_NAME}/pulls/${pull.number}`);
    assert.equal(detail.state, 'open');
    assert.equal(detail.merged, false);

    // The recorded prUrl must be a real, reachable page on the git host.
    const page = await fetch(EXPECTED_PR_URL);
    assert.equal(page.status, 200, `PR web page -> ${page.status}`);
  });

  await t.test('token usage is recorded on the task and in /api/usage', async () => {
    assert.ok(final.llmTokensUsed > 0, `task llmTokensUsed: ${final.llmTokensUsed}`);
    assert.ok(final.llmPromptTokens > 0, `task llmPromptTokens: ${final.llmPromptTokens}`);
    assert.ok(final.llmCompletionTokens > 0, `task llmCompletionTokens: ${final.llmCompletionTokens}`);

    const usage = await api('GET', '/usage?period=7d', { cookie: true });
    assert.equal(usage.status, 200, `GET /usage -> ${usage.status}`);
    assert.ok(
      usage.json.totals.totalTokens >= final.llmTokensUsed,
      `usage totals ${usage.json.totals.totalTokens} < task ${final.llmTokensUsed}`,
    );
    assert.ok(usage.json.totals.promptTokens > 0);
    assert.ok(usage.json.totals.completionTokens > 0);
    const repoBucket = usage.json.byRepository.find((bucket) => bucket.fullName === REPO_FULL_NAME);
    assert.ok(repoBucket, `no usage bucket for ${REPO_FULL_NAME}`);
    assert.ok(repoBucket.totalTokens >= final.llmTokensUsed);
    assert.ok(usage.json.byDay.length >= 1, 'expected at least one daily usage bucket');
  });

  await t.test('a "PR opened" notification was recorded', async () => {
    const response = await api('GET', '/notifications', { cookie: true });
    assert.equal(response.status, 200, `GET /notifications -> ${response.status}`);
    const notification = response.json.notifications.find(
      (entry) => entry.kind === 'pr_opened' && entry.taskId === task.id,
    );
    assert.ok(notification, `no pr_opened notification for task ${task.id}`);
    assert.equal(notification.prUrl, EXPECTED_PR_URL);
    assert.ok(response.json.unreadCount >= 1);
  });
});

test('human review feedback produces a follow-up commit (poll fallback)', async (t) => {
  // GitVerse/Gitea has no webhook support (webhook-registry.ts), so this
  // scenario rides the pr-state-sync poll fallback — shortened to 10s via
  // PR_STATE_SYNC_INTERVAL_MS in docker-compose.e2e.yml. The comment is
  // posted by a SECOND Gitea user: the loop deliberately ignores comments
  // authored by the connection's own account.
  const REVIEW_BODY = 'e2e review feedback: document the smoke marker file';

  await t.test('the repo opts in via autoAddressReview (default off)', async () => {
    assert.equal(repository.autoAddressReview ?? false, false, 'flag must default to off');
    const enabled = await api('PATCH', `/repositories/${repository.id}`, {
      cookie: true,
      body: { autoAddressReview: true },
    });
    assert.equal(enabled.status, 200, `enable autoAddressReview -> ${enabled.status}: ${enabled.text}`);
    assert.equal(enabled.json.repository.autoAddressReview, true);
  });

  const beforeRefs = await git(['ls-remote', CLONE_URL, `refs/heads/${EXPECTED_BRANCH}`]);
  const beforeSha = beforeRefs.split(/\s/)[0];
  assert.ok(beforeSha, `no remote head for ${EXPECTED_BRANCH}`);

  await t.test('a scripted review comment lands on the PR via the Gitea API', async () => {
    const review = await giteaSend('POST', `/repos/${REPO_FULL_NAME}/pulls/1/reviews`, {
      token: REVIEWER_PAT,
      body: {
        body: 'e2e: requesting a change',
        event: 'COMMENT',
        comments: [{ path: 'E2E_SMOKE.md', new_position: 1, body: REVIEW_BODY }],
      },
    });
    assert.ok(review?.id, 'Gitea returned no review id');
  });

  await t.test('a follow-up commit lands on the agent branch', async () => {
    const deadline = Date.now() + REVIEW_TIMEOUT_MS;
    let headSha = beforeSha;
    while (headSha === beforeSha) {
      assert.ok(
        Date.now() < deadline,
        `no follow-up commit on ${EXPECTED_BRANCH} within ${REVIEW_TIMEOUT_MS}ms`,
      );
      await sleep(2000);
      headSha = (await git(['ls-remote', CLONE_URL, `refs/heads/${EXPECTED_BRANCH}`])).split(/\s/)[0];
    }

    // The new commit carries the stub LLM's review-fix change-set.
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-fix-clone-'));
    await git(['clone', '--branch', EXPECTED_BRANCH, '--depth', '1', CLONE_URL, dir]);
    const fix = readFileSync(path.join(dir, 'E2E_REVIEW_FIX.md'), 'utf8');
    assert.match(fix, /addressing a human review comment/);
  });

  await t.test('task events summarize the addressed review comment', async () => {
    // Poll instead of reading once: the follow-up commit becomes visible via
    // ls-remote the moment the remote acks the push, but the job writes its
    // completion lines (pushed/addressed + notification) a few hundred ms
    // later — a single read right after the head change races the job.
    const deadline = Date.now() + REVIEW_TIMEOUT_MS;
    let lines = [];
    for (;;) {
      const eventsResponse = await api('GET', `/tasks/${task.id}/events`, { cookie: true });
      assert.equal(eventsResponse.status, 200);
      const freshEvents = eventsResponse.json;
      lines = freshEvents
        .filter((event) => event.kind === 'log')
        .map((event) => event.payload.line);
      const done =
        lines.some((line) => /^addressing review comment rc-\d+ from @e2e-reviewer/.test(line)) &&
        // The lemcore fix iteration's own completion line proves the fix landed.
        lines.some((line) => line.includes(`pushed review fixes to ${EXPECTED_BRANCH}`)) &&
        lines.some((line) => /^addressed review comment rc-\d+$/.test(line));
      if (done) break;
      assert.ok(Date.now() < deadline, `console missing the address-review lines; lines:\n${lines.join('\n')}`);
      await sleep(1000);
    }
  });

  await t.test('a "review addressed" notification was recorded', async () => {
    const deadline = Date.now() + REVIEW_TIMEOUT_MS;
    for (;;) {
      const response = await api('GET', '/notifications', { cookie: true });
      assert.equal(response.status, 200, `GET /notifications -> ${response.status}`);
      const notification = response.json.notifications.find(
        (entry) => entry.kind === 'review_addressed' && entry.taskId === task.id,
      );
      if (notification) {
        assert.equal(notification.prUrl, EXPECTED_PR_URL);
        return;
      }
      assert.ok(Date.now() < deadline, `no review_addressed notification for task ${task.id}`);
      await sleep(1000);
    }
  });
});

test('Prometheus series are present (worker open, backend token-guarded)', async () => {
  // The worker serves /metrics unauthenticated on its health port. The
  // lemniscate_queue_jobs gauges are refreshed on a 15s poller, so a fast
  // suite can arrive before the first tick — poll briefly for them.
  let workerText = '';
  const deadline = Date.now() + 45_000;
  for (;;) {
    const workerMetrics = await fetch(`${WORKER_HEALTH_URL}/metrics`);
    assert.equal(workerMetrics.status, 200);
    workerText = await workerMetrics.text();
    if (/lemniscate_queue_jobs\{queue="[^"]+",state="[^"]+"\} \d+/.test(workerText)) break;
    assert.ok(Date.now() < deadline, 'worker /metrics never exposed lemniscate_queue_jobs series');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.match(workerText, /lemniscate_llm_requests_total\{outcome="success"\} [1-9]/);
  assert.match(workerText, /lemniscate_job_duration_seconds_count\{job_name="[^"]+"\} [1-9]/);

  // The backend's /metrics is guarded by METRICS_TOKEN (e2e compose sets a
  // throwaway one): 401 without it, 200 with it.
  const unauthenticated = await fetch(`${BACKEND_URL}/metrics`);
  assert.equal(unauthenticated.status, 401);
  const backendMetrics = await fetch(`${BACKEND_URL}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  assert.equal(backendMetrics.status, 200);
  const backendText = await backendMetrics.text();
  assert.match(backendText, /lemniscate_http_requests_total\{[^}]+\} [1-9]/);
});
