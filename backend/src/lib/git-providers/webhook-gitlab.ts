import { safeEqualSecret } from '../secret-compare.js';
import type { ProviderWebhookApi, WebhookEvent } from './webhook-types.js';

// GitLab inbound webhook verification + event mapping.
//
// GitLab webhooks are verified with a simple shared-secret token sent in the
// X-Gitlab-Token header (no HMAC). We compare it in constant time via
// safeEqualSecret — the same helper used for the metrics and Traefik tokens
// (AGENTS.md §6 — single home for secret comparison).

const GITLAB_TOKEN_HEADER = 'x-gitlab-token';
const GITLAB_EVENT_HEADER = 'x-gitlab-event';
const GITLAB_UUID_HEADER = 'x-gitlab-event-uuid';

function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Verifies the GitLab X-Gitlab-Token header against the connection's secret. */
export function verifyGitlabWebhook(
  headers: Record<string, string | string[] | undefined>,
  _rawBody: Buffer,
  secret: string,
): boolean {
  return safeEqualSecret(headerString(headers, GITLAB_TOKEN_HEADER), secret);
}

// Maps a GitLab merge_request event to a normalized webhook event.
function parseGitlabMergeRequest(
  attrs: { action?: unknown; source_branch?: unknown },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  const headBranch = attrs.source_branch;
  if (typeof headBranch !== 'string' || !headBranch) return null;
  const action = attrs.action;
  if (action === 'merge') {
    return { kind: 'pr_merged', repoFullName, headBranch, deliveryId };
  }
  if (action === 'close' || action === 'closed') {
    return { kind: 'pr_closed', repoFullName, headBranch, deliveryId };
  }
  return null;
}

// Maps a GitLab pipeline event to ci_status.
function parseGitlabPipeline(
  attrs: { ref?: unknown },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  const headBranch = attrs.ref;
  if (typeof headBranch !== 'string' || !headBranch) return null;
  return { kind: 'ci_status', repoFullName, headBranch, deliveryId };
}

// Maps a GitLab pipeline with status=failed to ci_failed (event trigger).
function parseGitlabPipelineFailure(
  attrs: { status?: unknown; ref?: unknown },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  if (attrs.status !== 'failed') return null;
  const headBranch = attrs.ref;
  if (typeof headBranch !== 'string' || !headBranch) return null;
  return { kind: 'ci_failed', repoFullName, headBranch, deliveryId };
}

// Maps a GitLab issue event with action=open to issue_opened (event trigger).
function parseGitlabIssue(
  attrs: { action?: unknown },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  if (attrs.action !== 'open') return null;
  return { kind: 'issue_opened', repoFullName, headBranch: '', deliveryId };
}

/** Parses a verified GitLab webhook payload into a normalized event. */
export function parseGitlabWebhook(
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
): WebhookEvent | null {
  const eventType = headerString(headers, GITLAB_EVENT_HEADER);
  const deliveryId = headerString(headers, GITLAB_UUID_HEADER) ?? null;
  if (!eventType) return null;
  const body = (payload ?? {}) as Record<string, unknown>;
  const project = body.project as { path_with_namespace?: string } | undefined;
  const repoFullName = project?.path_with_namespace;
  if (typeof repoFullName !== 'string' || !repoFullName) return null;

  if (eventType === 'merge_request' || eventType === 'Merge Request Hook') {
    const attrs = body.object_attributes as { action?: unknown; source_branch?: unknown } | undefined;
    if (!attrs) return null;
    return parseGitlabMergeRequest(attrs, deliveryId, repoFullName);
  }
  if (eventType === 'pipeline' || eventType === 'Pipeline Hook') {
    const attrs = body.object_attributes as { status?: unknown; ref?: unknown } | undefined;
    if (!attrs) return null;
    // pipeline with status=failed emits ci_failed (event trigger) BEFORE the
    // generic ci_status mapping — a failed pipeline is actionable on its own.
    const failed = parseGitlabPipelineFailure(attrs, deliveryId, repoFullName);
    if (failed) return failed;
    return parseGitlabPipeline(attrs, deliveryId, repoFullName);
  }
  if (eventType === 'issue' || eventType === 'Issue Hook') {
    const attrs = body.object_attributes as { action?: unknown } | undefined;
    if (!attrs) return null;
    return parseGitlabIssue(attrs, deliveryId, repoFullName);
  }
  return null;
}

export const gitlabWebhookApi: ProviderWebhookApi = {
  verifySignature: verifyGitlabWebhook,
  parseEvent: parseGitlabWebhook,
};
