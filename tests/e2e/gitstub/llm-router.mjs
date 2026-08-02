// Pure scenario router for the e2e mock LLM (no server side effects), kept
// separate from stub-server.mjs so the backend unit test
// (backend/tests/e2e-stub-llm-router.test.ts) can import and lock the
// routing rules directly. The router answers deterministically based on the
// prompt text:
//   - branch-slug prompt     -> "e2e-smoke"
//   - commit-message prompt  -> a fixed conventional-commit line
//   - review-fix prompt      -> the change-set JSON from llm-fixture-fix.json
//                               (a DIFFERENT change-set than the task run's,
//                               so the address-review job produces a real
//                               follow-up commit)
//   - anything else          -> the change-set JSON from llm-fixture.json
//                               (parseability locked by
//                               backend/tests/e2e-stub-llm-fixture.test.ts)

export const BRANCH_SLUG_REPLY = 'e2e-smoke';
export const COMMIT_MESSAGE_REPLY = 'feat: add e2e smoke marker file';
export const PREFLIGHT_REPLY = 'IMPLEMENT\nThe requested behavior is not visible in the digest.';
export const DIGEST_REPLY = '# Repository digest\n- Single-purpose e2e smoke repository.\n';
export const LEMCORE_DONE_REPLY = 'Implemented the requested file.';
export const SMOKE_FILE_PATH = 'E2E_SMOKE.md';
export const FIX_FILE_PATH = 'E2E_REVIEW_FIX.md';
export const SMOKE_FILE_CONTENT =
  '# E2E Smoke\n\nWritten by the stub LLM during the e2e smoke run.\n';
export const FIX_FILE_CONTENT =
  '# E2E Review Fix\n\nWritten by the stub LLM while addressing a human review comment.\n';

export function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return '';
}

/**
 * Full routing decision. Auxiliary one-shot prompts (branch slug, commit
 * message, pre-flight verdict, repo digest) always get plain content. When
 * the request carries function tools (the lemcore agent loop), the first
 * turn gets a write_file tool call for the scenario file — the review-fix
 * file when the prompt carries buildFixUserPrompt's '# Code review feedback'
 * heading, the smoke marker otherwise — and any later turn (a tool result is
 * in the transcript) gets a plain final answer so the loop finishes.
 */
export function completionResponse(messages, hasTools, changesFixture, fixFixture) {
  const text = (messages ?? []).map(messageText).join('\n');
  if (text.includes('branch slug')) return { type: 'content', content: BRANCH_SLUG_REPLY };
  if (text.includes('conventional-commit')) return { type: 'content', content: COMMIT_MESSAGE_REPLY };
  if (text.includes('Decide whether a coding task still needs implementation')) {
    return { type: 'content', content: PREFLIGHT_REPLY };
  }
  if (text.includes('architecture digest')) return { type: 'content', content: DIGEST_REPLY };
  if (hasTools) {
    const done = (messages ?? []).some((message) => message?.role === 'tool');
    if (done) return { type: 'content', content: LEMCORE_DONE_REPLY };
    // Review-fix prompts: buildFixUserPrompt's '# Code review feedback'
    // heading (internal executor, kept for the fixture path) and
    // buildAgentFixPrompt's 'requested changes' line (lemcore fix iteration,
    // used by the review loop AND the address-review job).
    const isFix =
      text.includes('# Code review feedback') ||
      text.includes('requested changes');
    return {
      type: 'tool_calls',
      name: 'write_file',
      arguments: isFix
        ? { path: FIX_FILE_PATH, content: FIX_FILE_CONTENT }
        : { path: SMOKE_FILE_PATH, content: SMOKE_FILE_CONTENT },
    };
  }
  if (text.includes('# Code review feedback')) {
    return { type: 'content', content: fixFixture ?? changesFixture };
  }
  return { type: 'content', content: changesFixture };
}

export function completionContent(messages, changesFixture, fixFixture) {
  const text = completionResponse(messages, false, changesFixture, fixFixture).content;
  return text;
}
