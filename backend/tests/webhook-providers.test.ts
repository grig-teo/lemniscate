import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../src/lib/git-providers/webhook-types.js';
import { parseGithubWebhook, verifyGithubWebhook } from '../src/lib/git-providers/webhook-github.js';
import { parseGitlabWebhook, verifyGitlabWebhook } from '../src/lib/git-providers/webhook-gitlab.js';
import { getProviderWebhookApi } from '../src/lib/git-providers/webhook-registry.js';
import { safeEqualHexSignature } from '../src/lib/secret-compare.js';

const SECRET = 'super-secret-webhook-key';

function githubSignature(body: string, secret: string = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function githubHeaders(
  body: string,
  event: string,
  delivery = 'delivery-uuid-123',
  secret = SECRET,
): Record<string, string> {
  return {
    'x-hub-signature-256': githubSignature(body, secret),
    'x-github-event': event,
    'x-github-delivery': delivery,
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// safeEqualHexSignature
// ---------------------------------------------------------------------------

describe('safeEqualHexSignature', () => {
  it('accepts matching hex strings', () => {
    const sig = createHmac('sha256', SECRET).update('body').digest('hex');
    expect(safeEqualHexSignature(sig, sig)).toBe(true);
  });

  it('rejects non-matching hex of the same length', () => {
    const a = createHmac('sha256', 'key-a').update('body').digest('hex');
    const b = createHmac('sha256', 'key-b').update('body').digest('hex');
    expect(safeEqualHexSignature(a, b)).toBe(false);
  });

  it('rejects different-length inputs without throwing', () => {
    expect(safeEqualHexSignature('abc', 'abcdef')).toBe(false);
    expect(safeEqualHexSignature('abcdef', 'abc')).toBe(false);
  });

  it('rejects empty expected', () => {
    expect(safeEqualHexSignature('abc', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub webhook verification
// ---------------------------------------------------------------------------

describe('verifyGithubWebhook', () => {
  it('accepts a correctly signed payload', () => {
    const body = '{"action":"closed"}';
    const headers = githubHeaders(body, 'pull_request');
    expect(verifyGithubWebhook(headers, Buffer.from(body), SECRET)).toBe(true);
  });

  it('rejects an unsigned payload', () => {
    const body = '{"action":"closed"}';
    expect(verifyGithubWebhook({}, Buffer.from(body), SECRET)).toBe(false);
  });

  it('rejects a wrong-signature payload', () => {
    const body = '{"action":"closed"}';
    const headers = githubHeaders(body, 'pull_request', 'deliv', 'wrong-secret');
    expect(verifyGithubWebhook(headers, Buffer.from(body), SECRET)).toBe(false);
  });

  it('rejects a signature without the sha256= prefix', () => {
    const body = '{"action":"closed"}';
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(
      verifyGithubWebhook({ 'x-hub-signature-256': sig }, Buffer.from(body), SECRET),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub webhook event parsing
// ---------------------------------------------------------------------------

const GITHUB_PR_MERGED = {
  action: 'closed',
  pull_request: {
    merged: true,
    number: 42,
    head: { ref: 'lemniscate/t-1', repo: { full_name: 'org/demo' } },
    base: { ref: 'main' },
  },
  repository: { full_name: 'org/demo' },
};

const GITHUB_PR_CLOSED = {
  action: 'closed',
  pull_request: {
    merged: false,
    number: 42,
    head: { ref: 'lemniscate/t-1', repo: { full_name: 'org/demo' } },
    base: { ref: 'main' },
  },
  repository: { full_name: 'org/demo' },
};

const GITHUB_PR_OPENED = {
  action: 'opened',
  pull_request: {
    merged: false,
    number: 42,
    head: { ref: 'lemniscate/t-1', repo: { full_name: 'org/demo' } },
    base: { ref: 'main' },
  },
  repository: { full_name: 'org/demo' },
};

const GITHUB_CHECK_SUITE_COMPLETED = {
  action: 'completed',
  check_suite: {
    head_branch: 'lemniscate/t-1',
    conclusion: 'success',
    pull_requests: [{ head: { ref: 'lemniscate/t-1' }, base: { ref: 'main' } }],
  },
  repository: { full_name: 'org/demo' },
};

describe('parseGithubWebhook', () => {
  it('maps pull_request closed+merged to pr_merged', () => {
    const headers = { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1' };
    const event = parseGithubWebhook(GITHUB_PR_MERGED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'pr_merged',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'd-1',
    });
  });

  it('maps pull_request closed+not-merged to pr_closed', () => {
    const headers = { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-2' };
    const event = parseGithubWebhook(GITHUB_PR_CLOSED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'pr_closed',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'd-2',
    });
  });

  it('ignores pull_request opened (not closed)', () => {
    const headers = { 'x-github-event': 'pull_request', 'x-github-delivery': 'd-3' };
    expect(parseGithubWebhook(GITHUB_PR_OPENED, headers)).toBeNull();
  });

  it('maps check_suite completed to ci_status', () => {
    const headers = { 'x-github-event': 'check_suite', 'x-github-delivery': 'd-4' };
    const event = parseGithubWebhook(GITHUB_CHECK_SUITE_COMPLETED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'ci_status',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'd-4',
    });
  });

  it('ignores irrelevant event types', () => {
    expect(parseGithubWebhook({}, { 'x-github-event': 'push' })).toBeNull();
    expect(parseGithubWebhook({}, { 'x-github-event': 'ping' })).toBeNull();
  });

  it('returns null deliveryId when header is absent', () => {
    const headers = { 'x-github-event': 'pull_request' };
    const event = parseGithubWebhook(GITHUB_PR_MERGED, headers);
    expect(event?.deliveryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitLab webhook verification
// ---------------------------------------------------------------------------

function gitlabHeaders(token: string, event = 'merge_request', uuid = 'gl-uuid-1'): Record<string, string> {
  return {
    'x-gitlab-token': token,
    'x-gitlab-event': event,
    'x-gitlab-event-uuid': uuid,
    'content-type': 'application/json',
  };
}

describe('verifyGitlabWebhook', () => {
  it('accepts the correct token', () => {
    const headers = gitlabHeaders(SECRET);
    expect(verifyGitlabWebhook(headers, Buffer.from('{}'), SECRET)).toBe(true);
  });

  it('rejects a missing token', () => {
    expect(verifyGitlabWebhook({}, Buffer.from('{}'), SECRET)).toBe(false);
  });

  it('rejects a wrong token', () => {
    const headers = gitlabHeaders('wrong-token');
    expect(verifyGitlabWebhook(headers, Buffer.from('{}'), SECRET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitLab webhook event parsing
// ---------------------------------------------------------------------------

const GITLAB_MR_MERGED = {
  object_kind: 'merge_request',
  object_attributes: {
    action: 'merge',
    source_branch: 'lemniscate/t-1',
    target_branch: 'main',
    state: 'merged',
  },
  project: { path_with_namespace: 'org/demo' },
};

const GITLAB_MR_CLOSED = {
  object_kind: 'merge_request',
  object_attributes: {
    action: 'close',
    source_branch: 'lemniscate/t-1',
    target_branch: 'main',
    state: 'closed',
  },
  project: { path_with_namespace: 'org/demo' },
};

const GITLAB_PIPELINE = {
  object_kind: 'pipeline',
  object_attributes: {
    status: 'success',
    ref: 'lemniscate/t-1',
  },
  project: { path_with_namespace: 'org/demo' },
};

describe('parseGitlabWebhook', () => {
  it('maps merge_request merge action to pr_merged', () => {
    const headers = { 'x-gitlab-event': 'merge_request', 'x-gitlab-event-uuid': 'gl-1' };
    const event = parseGitlabWebhook(GITLAB_MR_MERGED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'pr_merged',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'gl-1',
    });
  });

  it('maps merge_request close action to pr_closed', () => {
    const headers = { 'x-gitlab-event': 'merge_request', 'x-gitlab-event-uuid': 'gl-2' };
    const event = parseGitlabWebhook(GITLAB_MR_CLOSED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'pr_closed',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'gl-2',
    });
  });

  it('maps pipeline success to ci_status', () => {
    const headers = { 'x-gitlab-event': 'pipeline', 'x-gitlab-event-uuid': 'gl-3' };
    const event = parseGitlabWebhook(GITLAB_PIPELINE, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'ci_status',
      repoFullName: 'org/demo',
      headBranch: 'lemniscate/t-1',
      deliveryId: 'gl-3',
    });
  });

  it('ignores irrelevant event types', () => {
    expect(parseGitlabWebhook({}, { 'x-gitlab-event': 'push' })).toBeNull();
    expect(parseGitlabWebhook({}, { 'x-gitlab-event': 'ping' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GitHub event-driven triggers (ci_failed, issue_opened)
// ---------------------------------------------------------------------------

const GITHUB_CHECK_RUN_FAILURE = {
  action: 'completed',
  check_run: {
    name: 'CI',
    conclusion: 'failure',
    check_suite: { head_branch: 'main' },
  },
  repository: { full_name: 'org/demo' },
};

const GITHUB_CHECK_RUN_SUCCESS = {
  action: 'completed',
  check_run: {
    name: 'CI',
    conclusion: 'success',
    check_suite: { head_branch: 'main' },
  },
  repository: { full_name: 'org/demo' },
};

const GITHUB_ISSUE_OPENED = {
  action: 'opened',
  issue: { number: 7, title: 'Bug: login fails', body: 'Steps to reproduce…' },
  repository: { full_name: 'org/demo' },
};

const GITHUB_ISSUE_CLOSED = {
  action: 'closed',
  issue: { number: 7, title: 'Bug: login fails', body: '' },
  repository: { full_name: 'org/demo' },
};

describe('parseGithubWebhook — event-driven triggers', () => {
  it('maps check_run conclusion=failure to ci_failed', () => {
    const headers = { 'x-github-event': 'check_run', 'x-github-delivery': 'd-ci-fail' };
    const event = parseGithubWebhook(GITHUB_CHECK_RUN_FAILURE, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'ci_failed',
      repoFullName: 'org/demo',
      headBranch: 'main',
      deliveryId: 'd-ci-fail',
    });
  });

  it('does NOT map check_run conclusion=success to ci_failed', () => {
    const headers = { 'x-github-event': 'check_run', 'x-github-delivery': 'd-ci-ok' };
    const event = parseGithubWebhook(GITHUB_CHECK_RUN_SUCCESS, headers);
    expect(event?.kind).not.toBe('ci_failed');
  });

  it('maps issues action=opened to issue_opened', () => {
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'd-issue-1' };
    const event = parseGithubWebhook(GITHUB_ISSUE_OPENED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'issue_opened',
      repoFullName: 'org/demo',
      headBranch: '',
      deliveryId: 'd-issue-1',
    });
  });

  it('does NOT map issues action=closed to issue_opened', () => {
    const headers = { 'x-github-event': 'issues', 'x-github-delivery': 'd-issue-2' };
    const event = parseGithubWebhook(GITHUB_ISSUE_CLOSED, headers);
    expect(event?.kind).not.toBe('issue_opened');
  });
});

// ---------------------------------------------------------------------------
// GitLab event-driven triggers (ci_failed, issue_opened)
// ---------------------------------------------------------------------------

const GITLAB_PIPELINE_FAILED = {
  object_kind: 'pipeline',
  object_attributes: {
    status: 'failed',
    ref: 'main',
  },
  project: { path_with_namespace: 'org/demo' },
};

const GITLAB_PIPELINE_SUCCESS = {
  object_kind: 'pipeline',
  object_attributes: {
    status: 'success',
    ref: 'main',
  },
  project: { path_with_namespace: 'org/demo' },
};

const GITLAB_ISSUE_OPENED = {
  object_kind: 'issue',
  object_attributes: {
    action: 'open',
    title: 'Bug: login fails',
  },
  project: { path_with_namespace: 'org/demo' },
};

describe('parseGitlabWebhook — event-driven triggers', () => {
  it('maps pipeline status=failed to ci_failed', () => {
    const headers = { 'x-gitlab-event': 'pipeline', 'x-gitlab-event-uuid': 'gl-fail' };
    const event = parseGitlabWebhook(GITLAB_PIPELINE_FAILED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'ci_failed',
      repoFullName: 'org/demo',
      headBranch: 'main',
      deliveryId: 'gl-fail',
    });
  });

  it('does NOT map pipeline status=success to ci_failed', () => {
    const headers = { 'x-gitlab-event': 'pipeline', 'x-gitlab-event-uuid': 'gl-ok' };
    const event = parseGitlabWebhook(GITLAB_PIPELINE_SUCCESS, headers);
    expect(event?.kind).not.toBe('ci_failed');
  });

  it('maps issue open action to issue_opened', () => {
    const headers = { 'x-gitlab-event': 'issue', 'x-gitlab-event-uuid': 'gl-issue-1' };
    const event = parseGitlabWebhook(GITLAB_ISSUE_OPENED, headers);
    expect(event).toEqual<WebhookEvent>({
      kind: 'issue_opened',
      repoFullName: 'org/demo',
      headBranch: '',
      deliveryId: 'gl-issue-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Webhook provider registry
// ---------------------------------------------------------------------------

describe('getProviderWebhookApi', () => {
  it('returns the GitHub parser for github', () => {
    const api = getProviderWebhookApi('github');
    expect(api).not.toBeNull();
    expect(api?.verifySignature).toBeDefined();
    expect(api?.parseEvent).toBeDefined();
  });

  it('returns the GitLab parser for gitlab', () => {
    const api = getProviderWebhookApi('gitlab');
    expect(api).not.toBeNull();
    expect(api?.verifySignature).toBeDefined();
  });

  it('returns null for providers without webhook support', () => {
    expect(getProviderWebhookApi('gitverse')).toBeNull();
    expect(getProviderWebhookApi('gitee')).toBeNull();
  });
});
