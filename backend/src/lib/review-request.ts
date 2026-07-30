import type { Task } from '@prisma/client';
import { logEvent } from './agent-git.js';
import { llmCall, type LlmRuntime } from './agent-runtime.js';
import { buildReviewMessages, parsePrReview, type PrReview } from './pr-review.js';

// Retry-with-nudge for the direct review call. Some providers (z.ai GLM)
// intermittently answer with an empty message or non-JSON prose once the
// reasoning budget is consumed; the strict parse then killed the whole
// review job ("LLM returned an invalid review: String must contain at least
// 1 character(s)"). Empty/invalid replies are retried with an explicit
// nudge; real endpoint errors (auth, quota, timeouts) rethrow immediately —
// they have their own failover chain inside llmCall.

const MAX_INVALID_REVIEW_REPLIES = 3;

const RETRYABLE_PARSE_MARKERS = [
  'LLM response did not contain a JSON object',
  'LLM response contained malformed JSON',
  'an invalid review',
];

function isRetryableParseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_PARSE_MARKERS.some((marker) => message.includes(marker));
}

const REVIEW_REPLY_NUDGE =
  'Your previous reply was empty or not the requested review JSON. ' +
  'Reply with ONLY the JSON review object — no prose, no empty message.';

export async function requestReviewWithRetry(
  rt: LlmRuntime,
  task: Task,
  diff: string,
): Promise<PrReview> {
  const messages = buildReviewMessages({
    taskTitle: task.title,
    taskPrompt: task.prompt,
    diff,
    systemPromptExtra: rt.cfg.systemPromptExtra,
  });
  for (let attempt = 1; attempt <= MAX_INVALID_REVIEW_REPLIES; attempt++) {
    try {
      return parsePrReview(await llmCall(rt, messages));
    } catch (err) {
      if (!isRetryableParseError(err) || attempt === MAX_INVALID_REVIEW_REPLIES) throw err;
      await logEvent(
        task.id,
        `empty/invalid review reply — asking the model again (${attempt}/${MAX_INVALID_REVIEW_REPLIES})`,
      );
      messages.push(
        { role: 'assistant', content: '' },
        { role: 'user', content: REVIEW_REPLY_NUDGE },
      );
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  throw new Error('review retry loop exited unexpectedly');
}
