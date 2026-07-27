// Shared types for the per-provider inbound webhook parsers
// (webhook-github.ts, webhook-gitlab.ts). Each parser verifies the
// provider-specific signature and maps the payload to a normalized event.
// The provider selection happens in webhook-registry.ts (the single switch —
// AGENTS.md §4).

export type WebhookEventKind =
  | 'pr_merged'
  | 'pr_closed'
  | 'ci_status'
  | 'ci_failed'
  | 'issue_opened'
  | 'pr_review_comment';

/** A human-written PR review comment, normalized across providers. */
export interface ReviewComment {
  /**
   * Namespaced provider id ('rc-<n>' GitHub review comment, 'ic-<n>' PR
   * conversation comment, 'review-<n>' submitted review, 'note-<n>' GitLab
   * note). The namespace keeps provider id spaces from colliding; the whole
   * string is the dedupe key (Task.lastAddressedReviewId + BullMQ jobId).
   */
  id: string;
  body: string;
  /** Provider login of the comment author (the agent's own comments are ignored). */
  author: string;
  /** File path / line for inline review comments; absent on conversation-level ones. */
  path?: string;
  line?: number;
}

/** A normalized webhook event the receiver dispatches on. */
export interface WebhookEvent {
  kind: WebhookEventKind;
  repoFullName: string;
  headBranch: string;
  /** Provider delivery ID (X-GitHub-Delivery / X-Gitlab-Event-UUID) for replay dedup. */
  deliveryId: string | null;
  /** Present only for kind 'pr_review_comment'. */
  reviewComment?: ReviewComment;
}

/**
 * The ONE mapper from provider-specific comment fields to a normalized
 * pr_review_comment event (AGENTS.md §6) — the GitHub and GitLab parsers
 * extract raw fields and delegate the validation + namespacing here.
 * Returns null when the payload lacks an actionable comment (no id, empty
 * body, or no author).
 */
export function reviewCommentEvent(input: {
  /** Id namespace prefix, e.g. 'rc-', 'review-', 'note-'. */
  prefix: string;
  id: unknown;
  body: unknown;
  author: unknown;
  path?: unknown;
  line?: unknown;
  repoFullName: string;
  headBranch: string;
  deliveryId: string | null;
}): WebhookEvent | null {
  if (typeof input.id !== 'number' && typeof input.id !== 'string') return null;
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  const author = typeof input.author === 'string' ? input.author.trim() : '';
  if (!body || !author) return null;
  const path = typeof input.path === 'string' && input.path ? input.path : undefined;
  const line = typeof input.line === 'number' && Number.isInteger(input.line) ? input.line : undefined;
  return {
    kind: 'pr_review_comment',
    repoFullName: input.repoFullName,
    headBranch: input.headBranch,
    deliveryId: input.deliveryId,
    reviewComment: {
      id: `${input.prefix}${input.id}`,
      body,
      author,
      ...(path ? { path } : {}),
      ...(line !== undefined ? { line } : {}),
    },
  };
}

/** The uniform shape every provider webhook module implements. */
export interface ProviderWebhookApi {
  /**
   * Verifies the provider-specific signature/header against the raw body and
   * the connection's webhook secret. Returns false on any mismatch — the
   * route handler must 401 before any DB write.
   */
  verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
    secret: string,
  ): boolean;

  /**
   * Parses a verified payload into a normalized event, or null when the event
   * is not relevant (e.g. a push to a non-tracked branch, or an event type
   * Lemniscate does not act on).
   */
  parseEvent(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent | null;
}
