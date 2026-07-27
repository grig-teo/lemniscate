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

export function completionContent(messages, changesFixture, fixFixture) {
  const text = (messages ?? []).map(messageText).join('\n');
  if (text.includes('branch slug')) return BRANCH_SLUG_REPLY;
  if (text.includes('conventional-commit')) return COMMIT_MESSAGE_REPLY;
  // The fix prompt (buildFixUserPrompt) always carries this heading — route
  // it to the distinct fix change-set. Falls back to the main fixture when
  // no fix fixture was provided (unit tests, older callers).
  if (text.includes('# Code review feedback')) return fixFixture ?? changesFixture;
  return changesFixture;
}
