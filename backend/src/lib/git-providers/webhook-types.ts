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
  | 'issue_opened';

/** A normalized webhook event the receiver dispatches on. */
export interface WebhookEvent {
  kind: WebhookEventKind;
  repoFullName: string;
  headBranch: string;
  /** Provider delivery ID (X-GitHub-Delivery / X-Gitlab-Event-UUID) for replay dedup. */
  deliveryId: string | null;
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
