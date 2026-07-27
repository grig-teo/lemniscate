import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level test for the inbound webhook receiver. The provider parsers
// (webhook-github/gitlab) are real pure functions; prisma, crypto, redis,
// and the shared handlers are mocked so no DB/network is contacted.

const mocks = vi.hoisted(() => ({
  gitConnectionFindUnique: vi.fn(),
  taskFindFirst: vi.fn(),
  applyTaskPrStateSafe: vi.fn().mockResolvedValue(true),
  enqueueMergeGate: vi.fn().mockResolvedValue(undefined),
  enqueueRunTask: vi.fn().mockResolvedValue(undefined),
  fireEventTrigger: vi.fn().mockResolvedValue({ fired: false, reason: 'not_triggerable' }),
  redisSet: vi.fn().mockResolvedValue('OK'),
  decrypt: vi.fn().mockReturnValue('super-secret-webhook-key'),
}));

vi.mock('../src/config.js', () => ({
  config: {
    NODE_ENV: 'test',
    BACKEND_URL: 'http://localhost:3000',
    REDIS_URL: 'redis://localhost:6379',
    TRUST_PROXY: false,
    FRONTEND_URL: 'http://localhost:8080',
    AGENT_WORKDIR: '/tmp/test-workdirs',
  },
  MONITORED_SECRETS: [],
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    gitConnection: { findUnique: mocks.gitConnectionFindUnique },
    task: { findFirst: mocks.taskFindFirst },
  },
}));

vi.mock('../src/lib/crypto.js', () => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: mocks.decrypt,
}));

vi.mock('../src/lib/pr-merged-handler.js', () => ({
  applyTaskPrStateSafe: mocks.applyTaskPrStateSafe,
}));

vi.mock('../src/lib/proposal-scheduler.js', () => ({
  enqueueMergeGate: mocks.enqueueMergeGate,
  enqueueRunTask: mocks.enqueueRunTask,
  getAgentTasksQueue: vi.fn(),
}));

vi.mock('../src/lib/event-trigger-handler.js', async (importOriginal) => {
  // Spread the real module so TRIGGERABLE_EVENT_KINDS stays available to
  // routes/event-triggers.ts at import time; only the side-effecting
  // fireEventTrigger is stubbed.
  const actual =
    await importOriginal<typeof import('../src/lib/event-trigger-handler.js')>();
  return { ...actual, fireEventTrigger: mocks.fireEventTrigger };
});

vi.mock('../src/lib/redis.js', () => ({
  getRedisClient: () => ({ set: mocks.redisSet }),
}));

vi.mock('../src/lib/metrics.js', () => ({
  metrics: { observeJob: vi.fn(), render: vi.fn(() => '') },
  registerHttpMetricsHook: vi.fn(),
  registerMetricsRoute: vi.fn(),
}));

vi.mock('../src/lib/sentry.js', () => ({
  initErrorReporting: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock('ioredis', () => ({ Redis: vi.fn() }));

import { buildApp } from '../src/app.js';

const SECRET = 'super-secret-webhook-key';
const CONNECTION_ID = 'conn-123';
const TASK_ID = 'task-456';

function githubSig(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function connection(provider: string = 'github') {
  return {
    id: CONNECTION_ID,
    provider,
    baseUrl: null,
    webhookSecretEnc: 'enc:secret',
    disconnectedAt: null,
  };
}

function awaitingTask() {
  return {
    id: TASK_ID,
    title: 'Add feature X',
    status: 'awaiting_review',
    prUrl: 'https://github.com/org/demo/pull/42',
    branchName: 'lemniscate/t-1',
    repositoryId: 'repo-1',
    title2: 'Add feature X',
    repository: {
      id: 'repo-1',
      fullName: 'org/demo',
      defaultBranch: 'main',
      autoMergePr: true,
      connection: { id: CONNECTION_ID, userId: 'user-1', provider: 'github' },
    },
  };
}

const PR_MERGED_BODY = JSON.stringify({
  action: 'closed',
  pull_request: {
    merged: true,
    number: 42,
    head: { ref: 'lemniscate/t-1', repo: { full_name: 'org/demo' } },
    base: { ref: 'main' },
  },
  repository: { full_name: 'org/demo' },
});

const CHECK_SUITE_BODY = JSON.stringify({
  action: 'completed',
  check_suite: {
    head_branch: 'lemniscate/t-1',
    conclusion: 'success',
    pull_requests: [{ head: { ref: 'lemniscate/t-1' }, base: { ref: 'main' } }],
  },
  repository: { full_name: 'org/demo' },
});

describe('POST /api/webhooks/:connectionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gitConnectionFindUnique.mockResolvedValue(connection());
    mocks.taskFindFirst.mockResolvedValue(awaitingTask());
    mocks.applyTaskPrStateSafe.mockResolvedValue(true);
    mocks.enqueueMergeGate.mockResolvedValue(undefined);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.decrypt.mockReturnValue(SECRET);
  });

  it('rejects an unsigned payload with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.applyTaskPrStateSafe).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a wrong-signature payload with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-delivery': 'deliv-1',
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.applyTaskPrStateSafe).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects when the connection has no webhook secret configured (401)', async () => {
    mocks.gitConnectionFindUnique.mockResolvedValue({ ...connection(), webhookSecretEnc: null });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSig(PR_MERGED_BODY),
        'x-github-delivery': 'deliv-2',
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 404 when the connection does not exist', async () => {
    mocks.gitConnectionFindUnique.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/nonexistent`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSig(PR_MERGED_BODY),
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('accepts a valid signed PR-merged payload and dispatches the shared handler', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSig(PR_MERGED_BODY),
        'x-github-delivery': 'deliv-merged-1',
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.event).toBe('pr_merged');
    expect(mocks.applyTaskPrStateSafe).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID }),
      'merged',
      'webhook',
    );
    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringContaining('deliv-merged-1'),
      '1',
      'EX',
      expect.any(Number),
      'NX',
    );
    await app.close();
  });

  it('accepts a valid signed check_suite payload and enqueues merge-gate', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_suite',
        'x-hub-signature-256': githubSig(CHECK_SUITE_BODY),
        'x-github-delivery': 'deliv-ci-1',
      },
      payload: CHECK_SUITE_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('ci_status');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith(TASK_ID);
    await app.close();
  });

  it('skips silently when no awaiting_review task matches', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSig(PR_MERGED_BODY),
        'x-github-delivery': 'deliv-no-task',
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('no_task');
    expect(mocks.applyTaskPrStateSafe).not.toHaveBeenCalled();
    await app.close();
  });

  it('skips duplicate deliveries (replay dedup)', async () => {
    mocks.redisSet.mockResolvedValue(null); // key already existed
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': githubSig(PR_MERGED_BODY),
        'x-github-delivery': 'deliv-dup-1',
      },
      payload: PR_MERGED_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('duplicate');
    expect(mocks.applyTaskPrStateSafe).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts a valid GitLab token-signed payload', async () => {
    mocks.gitConnectionFindUnique.mockResolvedValue(connection('gitlab'));
    const gitlabBody = JSON.stringify({
      object_kind: 'merge_request',
      object_attributes: {
        action: 'merge',
        source_branch: 'lemniscate/t-1',
        target_branch: 'main',
        state: 'merged',
      },
      project: { path_with_namespace: 'org/demo' },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-gitlab-event': 'merge_request',
        'x-gitlab-token': SECRET,
        'x-gitlab-event-uuid': 'gl-uuid-1',
      },
      payload: gitlabBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('pr_merged');
    expect(mocks.applyTaskPrStateSafe).toHaveBeenCalled();
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Event-driven trigger dispatch
  // -----------------------------------------------------------------------

  const CHECK_RUN_FAILURE_BODY = JSON.stringify({
    action: 'completed',
    check_run: {
      name: 'CI',
      conclusion: 'failure',
      check_suite: { head_branch: 'main' },
    },
    repository: { full_name: 'org/demo' },
  });

  it('fires the event trigger for a check_run:failure on the default branch', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    mocks.fireEventTrigger.mockResolvedValue({ fired: true, reason: 'created' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': githubSig(CHECK_RUN_FAILURE_BODY),
        'x-github-delivery': 'deliv-trigger-1',
      },
      payload: CHECK_RUN_FAILURE_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('ci_failed');
    expect(mocks.fireEventTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ci_failed', headBranch: 'main' }),
    );
    await app.close();
  });

  it('still enqueues the merge gate for a check_run:failure on an awaiting PR branch', async () => {
    // Regression lock: ci_failed on a branch with an awaiting task must kick
    // the merge gate (its CI-fix loop), not just the event trigger.
    const prBranchFailure = JSON.stringify({
      action: 'completed',
      check_run: {
        name: 'CI',
        conclusion: 'failure',
        check_suite: { head_branch: 'lemniscate/t-1' },
      },
      repository: { full_name: 'org/demo' },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': githubSig(prBranchFailure),
        'x-github-delivery': 'deliv-ci-fail-pr-1',
      },
      payload: prBranchFailure,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('ci_failed');
    expect(mocks.enqueueMergeGate).toHaveBeenCalledWith(TASK_ID);
    await app.close();
  });

  it('returns no_task when the event trigger does not fire', async () => {
    mocks.taskFindFirst.mockResolvedValue(null);
    mocks.fireEventTrigger.mockResolvedValue({ fired: false, reason: 'no_trigger' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${CONNECTION_ID}`,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'check_run',
        'x-hub-signature-256': githubSig(CHECK_RUN_FAILURE_BODY),
        'x-github-delivery': 'deliv-trigger-2',
      },
      payload: CHECK_RUN_FAILURE_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().event).toBe('no_task');
    await app.close();
  });
});
