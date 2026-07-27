import { createHmac } from 'node:crypto';
import { safeEqualHexSignature } from '../secret-compare.js';
import type { ProviderWebhookApi, WebhookEvent } from './webhook-types.js';

// GitHub inbound webhook verification + event mapping.
//
// GitHub signs every webhook delivery with HMAC-SHA256 in the
// X-Hub-Signature-256 header (`sha256=<hex>`), computed over the raw body.
// We re-compute the HMAC with the connection's webhook secret and compare
// in constant time (safeEqualHexSignature) so the guard never leaks the
// secret through timing.

const GITHUB_SIGNATURE_HEADER = 'x-hub-signature-256';
const GITHUB_EVENT_HEADER = 'x-github-event';
const GITHUB_DELIVERY_HEADER = 'x-github-delivery';

function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Verifies the GitHub X-Hub-Signature-256 header against the raw body + secret. */
export function verifyGithubWebhook(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secret: string,
): boolean {
  const signature = headerString(headers, GITHUB_SIGNATURE_HEADER);
  if (!signature || !signature.startsWith('sha256=')) return false;
  const presented = signature.slice('sha256='.length);
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHexSignature(presented, expected);
}

// Extracts the head branch name from a GitHub pull_request payload.
function prHeadBranch(payload: {
  pull_request?: { head?: { ref?: string } };
}): string | null {
  const ref = payload.pull_request?.head?.ref;
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

function prRepoFullName(payload: {
  repository?: { full_name?: string };
  pull_request?: { head?: { repo?: { full_name?: string } } };
}): string | null {
  const fromRepo = payload.repository?.full_name;
  if (typeof fromRepo === 'string') return fromRepo;
  const fromPr = payload.pull_request?.head?.repo?.full_name;
  return typeof fromPr === 'string' ? fromPr : null;
}

// Maps a GitHub pull_request event to a normalized webhook event.
function parseGithubPullRequest(
  payload: { action?: unknown; pull_request?: { merged?: unknown } },
  deliveryId: string | null,
  repoFullName: string,
  headBranch: string,
): WebhookEvent | null {
  if (payload.action !== 'closed') return null;
  const merged = payload.pull_request?.merged === true;
  return {
    kind: merged ? 'pr_merged' : 'pr_closed',
    repoFullName,
    headBranch,
    deliveryId,
  };
}

// Maps a GitHub check_suite or check_run event to ci_status.
function parseGithubCheckEvent(
  payload: { check_suite?: { head_branch?: string }; check_run?: { check_suite?: { head_branch?: string } } },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  const headBranch = payload.check_suite?.head_branch ?? payload.check_run?.check_suite?.head_branch;
  if (typeof headBranch !== 'string' || !headBranch) return null;
  return { kind: 'ci_status', repoFullName, headBranch, deliveryId };
}

// Maps a GitHub check_run with conclusion=failure to ci_failed (event trigger).
function parseGithubCheckRunFailure(
  payload: { check_run?: { conclusion?: unknown; check_suite?: { head_branch?: string } } },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  if (payload.check_run?.conclusion !== 'failure') return null;
  const headBranch = payload.check_run?.check_suite?.head_branch;
  if (typeof headBranch !== 'string' || !headBranch) return null;
  return { kind: 'ci_failed', repoFullName, headBranch, deliveryId };
}

// Maps a GitHub issues event with action=opened to issue_opened (event trigger).
function parseGithubIssueEvent(
  payload: { action?: unknown },
  deliveryId: string | null,
  repoFullName: string,
): WebhookEvent | null {
  if (payload.action !== 'opened') return null;
  // Issues have no branch — empty string is the convention for branchless events.
  return { kind: 'issue_opened', repoFullName, headBranch: '', deliveryId };
}

/** Parses a verified GitHub webhook payload into a normalized event. */
export function parseGithubWebhook(
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
): WebhookEvent | null {
  const eventType = headerString(headers, GITHUB_EVENT_HEADER);
  const deliveryId = headerString(headers, GITHUB_DELIVERY_HEADER) ?? null;
  if (!eventType) return null;
  const body = (payload ?? {}) as Record<string, unknown>;
  const repoFullName = prRepoFullName(body as { repository?: { full_name?: string } });
  if (!repoFullName) return null;

  if (eventType === 'pull_request') {
    const headBranch = prHeadBranch(body as { pull_request?: { head?: { ref?: string } } });
    if (!headBranch) return null;
    return parseGithubPullRequest(body as { action?: unknown; pull_request?: { merged?: unknown } }, deliveryId, repoFullName, headBranch);
  }
  if (eventType === 'check_run') {
    const checkRunBody = body as {
      check_run?: { conclusion?: unknown; check_suite?: { head_branch?: string } };
    };
    // check_run with conclusion=failure emits ci_failed (event trigger) BEFORE
    // the generic ci_status mapping — a failed check is actionable on its own.
    const failed = parseGithubCheckRunFailure(checkRunBody, deliveryId, repoFullName);
    if (failed) return failed;
    return parseGithubCheckEvent(
      body as { check_suite?: { head_branch?: string }; check_run?: { check_suite?: { head_branch?: string } } },
      deliveryId,
      repoFullName,
    );
  }
  if (eventType === 'check_suite') {
    return parseGithubCheckEvent(
      body as { check_suite?: { head_branch?: string }; check_run?: { check_suite?: { head_branch?: string } } },
      deliveryId,
      repoFullName,
    );
  }
  if (eventType === 'issues') {
    return parseGithubIssueEvent(body as { action?: unknown }, deliveryId, repoFullName);
  }
  return null;
}

export const githubWebhookApi: ProviderWebhookApi = {
  verifySignature: verifyGithubWebhook,
  parseEvent: parseGithubWebhook,
};
