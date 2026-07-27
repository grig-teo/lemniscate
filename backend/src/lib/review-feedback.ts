// Pure rules for the human PR review feedback loop (AGENTS.md §6 — single
// home): which review comments are actionable, and which were already
// addressed. Shared by the webhook dispatch (routes/webhooks.ts), the
// address-review job (lib/address-review.ts), and the pr-state-sync poll
// fallback. No config/prisma imports so it stays unit-testable.

/** Minimal shape of an actionable review comment (webhook or provider API). */
export interface ReviewFeedbackComment {
  /** Namespaced id ('rc-<n>' GitHub, 'note-<n>' GitLab) — the dedupe key. */
  id: string;
  body: string;
  author: string;
  path?: string;
  line?: number;
}

// The agent's own comments (posted under the connection's account) must
// never trigger fixes — the agent would end up addressing itself.
export function isAgentAuthoredComment(
  author: string,
  connectionUsername: string | null | undefined,
): boolean {
  if (!connectionUsername) return false;
  return author.trim().toLowerCase() === connectionUsername.trim().toLowerCase();
}

// Namespaced ids embed the provider's monotonically increasing numeric id
// ('rc-1234' → 1234), so a single last-addressed marker covers everything
// older. Non-numeric ids fall back to exact equality.
export function isReviewCommentCovered(
  lastAddressedId: string | null | undefined,
  candidateId: string,
): boolean {
  if (!lastAddressedId) return false;
  if (lastAddressedId === candidateId) return true;
  const last = /(\d+)$/.exec(lastAddressedId);
  const candidate = /(\d+)$/.exec(candidateId);
  if (!last || !candidate) return false;
  return BigInt(candidate[1] ?? '0') <= BigInt(last[1] ?? '0');
}

/** Skip reason, or null when the comment should enqueue an address-review job. */
export function reviewFeedbackSkipReason(input: {
  taskStatus: string;
  branchName: string | null;
  lastAddressedReviewId: string | null;
  autoAddressReview: boolean;
  connectionUsername: string | null | undefined;
  comment: ReviewFeedbackComment;
}): string | null {
  if (!input.autoAddressReview) return 'flag_off';
  if (input.taskStatus !== 'awaiting_review' && input.taskStatus !== 'reviewing_code') {
    return 'not_awaiting_review';
  }
  if (!input.branchName) return 'no_branch';
  if (isAgentAuthoredComment(input.comment.author, input.connectionUsername)) return 'own_comment';
  if (isReviewCommentCovered(input.lastAddressedReviewId, input.comment.id)) return 'duplicate';
  if (!input.comment.body.trim()) return 'empty';
  return null;
}
