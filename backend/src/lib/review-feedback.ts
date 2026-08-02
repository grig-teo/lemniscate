// Pure rules for the human PR review feedback loop (AGENTS.md §6 — single
// home): provider payload parsing, which review comments are actionable, and
// which were already addressed. Shared by the webhook dispatch
// (routes/webhooks.ts), the address-review job (lib/address-review.ts), the
// provider PR API modules, and the pr-state-sync poll fallback. No
// config/prisma imports so it stays unit-testable.

import { z } from 'zod';

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
// older — but only within the SAME prefix: GitHub 'review-<n>' (submitted
// reviews) and 'rc-<n>' (review comments) are independent id sequences, so
// numeric comparison across prefixes would wrongly suppress comments.
// Different prefixes (or non-numeric ids) fall back to exact equality.
export function isReviewCommentCovered(
  lastAddressedId: string | null | undefined,
  candidateId: string,
): boolean {
  if (!lastAddressedId) return false;
  if (lastAddressedId === candidateId) return true;
  const last = /^(.*?)(\d+)$/.exec(lastAddressedId);
  const candidate = /^(.*?)(\d+)$/.exec(candidateId);
  if (!last || !candidate || last[1] !== candidate[1]) return false;
  return BigInt(candidate[2] ?? '0') <= BigInt(last[2] ?? '0');
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
  if (
    input.taskStatus !== 'awaiting_review' &&
    input.taskStatus !== 'reviewing_code' &&
    input.taskStatus !== 'waiting_ci'
  ) {
    return 'not_awaiting_review';
  }
  if (!input.branchName) return 'no_branch';
  if (isAgentAuthoredComment(input.comment.author, input.connectionUsername)) return 'own_comment';
  if (isReviewCommentCovered(input.lastAddressedReviewId, input.comment.id)) return 'duplicate';
  if (!input.comment.body.trim()) return 'empty';
  return null;
}

// ---------------------------------------------------------------------------
// Provider API payload parsing (pr-state-sync poll fallback)
// ---------------------------------------------------------------------------

// Zod shape of one comment carried in a job payload / stored marker.
export const reviewFeedbackCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string().min(1),
  author: z.string().min(1),
  path: z.string().optional(),
  line: z.number().int().optional(),
});

// GitHub-shaped review-comment payload — GitHub pulls/{n}/comments, and
// GitVerse/Gitea pulls/{n}/reviews/{id}/comments (the Gitea flavor has no
// pulls-level comments endpoint). ONE schema + mapper shared by those
// providers (AGENTS.md §6), not three copies.
export const githubPrReviewCommentListSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    user: z.object({ login: z.string() }).nullable(),
    path: z.string().optional(),
    line: z.number().nullable().optional(),
  }),
);

export function mapGithubPrReviewComments(
  raw: z.infer<typeof githubPrReviewCommentListSchema>,
): ReviewFeedbackComment[] {
  const comments: ReviewFeedbackComment[] = [];
  for (const c of raw) {
    if (!c.user?.login || !c.body.trim()) continue;
    comments.push({
      id: `rc-${c.id}`,
      body: c.body.trim(),
      author: c.user.login,
      ...(c.path ? { path: c.path } : {}),
      ...(typeof c.line === 'number' ? { line: c.line } : {}),
    });
  }
  return comments;
}

// GitLab MR notes payload. System notes ("added 1 commit", "mentioned in …")
// are provider bookkeeping, never review feedback, so they are dropped here.
const gitlabMrNoteListSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    system: z.boolean(),
    author: z.object({ username: z.string() }),
  }),
);

export function mapGitlabMrNotes(body: unknown): ReviewFeedbackComment[] {
  return gitlabMrNoteListSchema
    .parse(body)
    .filter((note) => !note.system && note.body.trim())
    .map((note) => ({
      id: `note-${note.id}`,
      body: note.body.trim(),
      author: note.author.username,
    }));
}
