// Structured agent loop: emits `agent_step` events, persists a resume transcript.
import { config } from '../../config.js';
import { chatCompletion } from '../llm-dispatch.js';
import type { ChatMessage } from '../llm-client.js';
import {
  MAX_TURNS,
  MAX_EMPTY_ASSISTANT_REPLIES,
  lemcoreSystemPrompt,
} from './loop-constants.js';
import type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';
import { chatWithTurnTimeout, repairOrphanedToolCalls, turnTimeoutMs } from './loop-types.js';
import { getAvailableTools } from './tool-catalog.js';
import { runToolCalls } from './loop-tool-runner.js';
import { getTodoList } from './todo-store.js';
import type { LemcoreSkill } from './skills.js';
import {
  compactTranscript,
  shouldCompactTranscript,
} from './loop-compact.js';
import { classifyAssistantReply, EMPTY_REPLY_NUDGE } from './loop-reply.js';
import { throwIfPaused } from '../task-pause.js';
export {
  MAX_TURNS,
  MAX_TOOL_FAILURES,
  MAX_EMPTY_ASSISTANT_REPLIES,
  TRANSCRIPT_FILE,
  REVIEW_FILENAME,
  DEFAULT_GOAL_PATTERN,
  lemcoreSystemPrompt,
  transcriptPath,
} from './loop-constants.js';
export type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';
export { LemcoreStalledError } from './loop-types.js';
import {
  nextStepId,
  publishStepEvent,
  scrubLegacyInCloneTranscript,
  loadTranscript,
  saveTranscript,
  checkReviewFile,
} from './loop-helpers.js';
export {
  scrubLegacyInCloneTranscript,
  loadTranscript,
} from './loop-helpers.js';
function toChatMessages(messages: LemcoreMessage[], workdir: string): ChatMessage[] {
  // The TODO list is module-level state keyed by workdir (not in the
  // transcript, so it survives compaction). Inject it as a system-reminder
  // prefix on the FIRST user message so the model always sees the current
  // list. Crucially the system message bytes never change across turns, so
  // the provider's prefix cache stays valid.
  const todo = getTodoList(workdir);
  const todoReminder = todo ? `[system-reminder] ## TODO\n${todo}\n\n` : '';
  let todoInjected = !todoReminder;
  const out: ChatMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content });
        break;
      case 'user':
        // Prepend the TODO reminder to the first user message only.
        out.push({ role: 'user', content: (todoInjected ? '' : todoReminder) + m.content });
        todoInjected = true;
        break;
      case 'assistant':
        out.push({
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls && m.toolCalls.length > 0 ? { tool_calls: m.toolCalls } : {}),
        });
        break;
      case 'tool':
        out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
        break;
    }
  }
  return out;
}
export async function runLemcoreLoop(opts: LemcoreRunOptions): Promise<string> {
  const { taskId, task, workdir, rt, prompt, secrets, resumeTranscript, skillsSection } = opts;
  const skills: LemcoreSkill[] = opts.skills ?? [];
  const messages: LemcoreMessage[] = resumeTranscript ? [...resumeTranscript] : [];
  const resuming = Boolean(resumeTranscript?.length);
  // Resume repair: a transcript saved mid-tool-call can end with an assistant
  // message carrying tool_calls but no matching `tool` result messages (the
  // process was killed between the assistant reply and the tool executor).
  // The OpenAI API rejects (HTTP 400) any assistant tool_calls that aren't
  // followed by their tool results. Synthesize a placeholder result for each
  // orphaned tool_call_id so the next provider call is well-formed; the model
  // can choose to re-run the tool if it still needs it.
  if (resuming) repairOrphanedToolCalls(messages);
  if (!messages.some((m) => m.role === 'system')) {
    const skillsBlock = skillsSection?.trim() ? `\n\n${skillsSection.trim()}` : '';
    const baseSystem = opts.systemPromptOverride ?? lemcoreSystemPrompt();
    // The system message is kept STABLE across turns (system prompt + skills
    // only) so the provider can cache it. All volatile content — the task
    // title, the task prompt, and the live TODO list — lives in the user
    // message below, where changing it doesn't invalidate the cached prefix.
    messages.push({
      role: 'system',
      content: `${baseSystem}${skillsBlock}`,
    });
  }
  if (!messages.some((m) => m.role === 'user')) {
    // The stored user message holds the task only; the live TODO is injected
    // into the first user message by toChatMessages each turn (kept out of
    // the stored system message so prompt caching isn't invalidated).
    const taskBlock = `${task.title}${task.prompt ? `\n${task.prompt}` : ''}`;
    messages.push({ role: 'user', content: `${prompt}\n\n${taskBlock}` });
  }
  saveTranscript(workdir, messages);
  if (resuming) {
    const priorToolSteps = resumeTranscript!.filter((m) => m.role === 'tool').length;
    const priorAssistant = resumeTranscript!.filter((m) => m.role === 'assistant').length;
    const fromStep = priorToolSteps + priorAssistant + 1;
    await publishStepEvent(taskId, {
      stepId: nextStepId(),
      status: 'done',
      kind: 'assistant',
      title: `Resumed from step ${fromStep}`,
      detail: `Continuing from saved transcript (${resumeTranscript!.length} messages).`,
    });
  }
  let consecutiveToolFailures = 0;
  let consecutiveEmptyReplies = 0;
  const startTime = Date.now();
  const wallClockCapMs = config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000;
  // Stall watchdog: a hung provider aborts the run fast instead of pinning the slot.
  const perTurnTimeoutMs = turnTimeoutMs(opts);
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // A paused run exits on the next turn boundary with the transcript
    // saved, so resume replays it instead of starting over.
    await throwIfPaused(taskId);
    if (Date.now() - startTime > wallClockCapMs) {
      throw new Error(`lemcore agent timed out after ${Math.round(wallClockCapMs / 1000)}s`);
    }
    if (shouldCompactTranscript(messages, rt.cfg.contextWindow)) {
      const before = messages.length;
      const compacted = compactTranscript(messages);
      messages.length = 0;
      messages.push(...compacted);
      await publishStepEvent(taskId, {
        stepId: nextStepId(),
        status: 'done',
        kind: 'assistant',
        title: 'Context compacted',
        detail: `Transcript compacted at ~80% of context window (${before} → ${messages.length} messages).`,
      });
      saveTranscript(workdir, messages);
    }
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    // Budget only when the config sets one (seeded with the task's
    // cumulative usage, so it spans the whole task).
    if (rt.cfg.maxTokensPerRun != null && rt.usedTokens + estimatedTokens > rt.cfg.maxTokensPerRun) {
      throw new Error(
        `LLM token budget exceeded (${rt.usedTokens + estimatedTokens} > ${rt.cfg.maxTokensPerRun})`,
      );
    }
    const stepId = nextStepId();
    const assistantStep: LemcoreStep = {
      stepId,
      status: 'running',
      kind: 'assistant',
      title: `Assistant turn ${turn + 1}`,
    };
    await publishStepEvent(taskId, assistantStep);
    const startedMs = Date.now();
    const result = await chatWithTurnTimeout(turn + 1, perTurnTimeoutMs, () =>
      chatCompletion({
        baseUrl: rt.cfg.baseUrl,
        apiKey: rt.apiKey,
        model: rt.cfg.model,
        apiPattern: rt.cfg.apiPattern,
        messages: toChatMessages(messages, workdir),
        // Completion budget per turn: the config's maxTokens wins (default
        // 16k), floored at 16k so thinking models have room for reasoning +
        // a real reply, and capped at 64k so a misconfigured value (e.g.
        // 1M) cannot make providers reject the call. The old hard 4096 cap
        // truncated thinking models mid-turn and killed runs with
        // "response truncated at maxTokens=4096".
        maxTokens: Math.min(Math.max(rt.cfg.maxTokens ?? 16_384, 16_384), 65_536),
        temperature: rt.cfg.temperature ?? 0.2,
        tools: getAvailableTools(),
        onRetry: (info) => {
          void publishStepEvent(taskId, {
            stepId: `${stepId}-retry-${info.attempt}`,
            status: 'running',
            kind: 'assistant',
            title: `Retry ${info.attempt}`,
            durationMs: info.delayMs,
          });
        },
      }),
    );
    if (result.usage?.totalTokens) {
      rt.usedTokens += result.usage.totalTokens;
      rt.usedPromptTokens += result.usage.promptTokens;
      rt.usedCompletionTokens += result.usage.completionTokens;
    }
    const toolCalls = result.toolCalls ?? [];
    const hasToolCalls = Boolean(result.hasToolCalls && toolCalls.length > 0);
    assistantStep.status = 'done';
    assistantStep.detail = result.content.slice(0, 500);
    assistantStep.durationMs = Date.now() - startedMs;
    assistantStep.tokensUsed = result.usage?.totalTokens;
    await publishStepEvent(taskId, assistantStep);
    messages.push({
      role: 'assistant',
      content: result.content,
      ...(hasToolCalls ? { toolCalls } : {}),
    });
    if (await checkReviewFile(workdir)) {
      saveTranscript(workdir, messages);
      return result.content;
    }
    const action = classifyAssistantReply(hasToolCalls, result.content, consecutiveEmptyReplies);
    // A non-empty text reply without tool calls is the agent's final answer.
    if (action.kind === 'final') {
      saveTranscript(workdir, messages);
      return result.content;
    }
    if (action.kind === 'abort') {
      throw new Error(
        `lemcore agent stopped: the LLM returned ${action.count} ` +
          'consecutive empty replies (no content, no tool calls)',
      );
    }
    if (action.kind === 'nudge') {
      consecutiveEmptyReplies = action.count;
      await publishStepEvent(taskId, {
        stepId: nextStepId(),
        status: 'done',
        kind: 'assistant',
        title: 'Empty LLM reply — nudging the model',
        detail:
          `Provider returned no content and no tool calls ` +
          `(${action.count}/${MAX_EMPTY_ASSISTANT_REPLIES}); asking the model to continue.`,
      });
      messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
      saveTranscript(workdir, messages);
      continue;
    }
    consecutiveEmptyReplies = 0;
    consecutiveToolFailures = await runToolCalls({
      taskId,
      workdir,
      secrets,
      toolCalls,
      messages,
      consecutiveToolFailures,
      nextStepId,
      publishStepEvent,
      skills,
      // rt is required for spawn_subagent and multi-sample edit verification;
      // without it both features silently no-op.
      rt,
    });
    saveTranscript(workdir, messages);
  }
  // MAX_TURNS exhausted — surface a truncation signal so the run isn't mistaken for done.
  const lastContent = messages[messages.length - 1]?.content ?? '';
  await publishStepEvent(taskId, {
    stepId: nextStepId(), status: 'done', kind: 'assistant',
    title: `Turn limit reached (${MAX_TURNS}) — run may be incomplete`,
  });
  return `[Run reached the ${MAX_TURNS}-turn limit without completing. ${lastContent}]`;
}
