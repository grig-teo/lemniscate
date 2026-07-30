// Structured agent loop for the lemcore executor.
// Emits structured `agent_step` events and persists a resume transcript.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { publishTaskEvent } from '../task-events.js';
import { chatCompletion } from '../llm-dispatch.js';
import type { ChatMessage } from '../llm-client.js';
import {
  MAX_TURNS,
  MAX_EMPTY_ASSISTANT_REPLIES,
  TRANSCRIPT_FILE,
  REVIEW_FILENAME,
  lemcoreSystemPrompt,
  transcriptPath,
} from './loop-constants.js';
import type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';
import { chatWithTurnTimeout, turnTimeoutMs } from './loop-types.js';
import { getAvailableTools } from './tool-catalog.js';
import { runToolCalls } from './loop-tool-runner.js';
import {
  compactTranscript,
  shouldCompactTranscript,
} from './loop-compact.js';

export {
  MAX_TURNS,
  MAX_TOOL_FAILURES,
  MAX_EMPTY_ASSISTANT_REPLIES,
  TRANSCRIPT_FILE,
  REVIEW_FILENAME,
  lemcoreSystemPrompt,
  transcriptPath,
} from './loop-constants.js';
export type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';
export { LemcoreStalledError } from './loop-types.js';

let stepCounter = 0;
function nextStepId(): string {
  return `step-${++stepCounter}`;
}

const EMPTY_REPLY_NUDGE =
  'Your previous reply was empty (no content and no tool calls). Continue the task: ' +
  'call the next tool, or — if the implementation is complete — reply with a concise ' +
  'summary of the changes as plain text.';

async function publishStepEvent(taskId: string, step: LemcoreStep): Promise<void> {
  await publishTaskEvent(taskId, 'agent_step', {
    stepId: step.stepId,
    status: step.status,
    kind: step.kind,
    tool: step.tool,
    title: step.title,
    detail: step.detail,
    outputPreview: step.outputPreview ? step.outputPreview.slice(0, 2_000) : undefined,
    durationMs: step.durationMs,
    tokensUsed: step.tokensUsed,
  });
}

/** Drop a legacy in-clone transcript left by older builds so it cannot be committed. */
export function scrubLegacyInCloneTranscript(workdir: string): void {
  const legacy = path.join(workdir, TRANSCRIPT_FILE);
  try {
    fs.unlinkSync(legacy);
  } catch {
    // absent is fine
  }
}

export function loadTranscript(workdir: string): LemcoreMessage[] | null {
  const file = transcriptPath(workdir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LemcoreMessage[];
  } catch {
    // no transcript or malformed
  }
  return null;
}

function saveTranscript(workdir: string, messages: LemcoreMessage[]): void {
  const file = transcriptPath(workdir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, file);
}

export async function checkReviewFile(workdir: string): Promise<boolean> {
  const file = path.join(workdir, REVIEW_FILENAME);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { verdict?: unknown };
    return typeof parsed.verdict === 'string';
  } catch {
    return false;
  }
}

function toChatMessages(messages: LemcoreMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
      case 'user':
        out.push({ role: m.role, content: m.content });
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
  const messages: LemcoreMessage[] = resumeTranscript ? [...resumeTranscript] : [];
  const resuming = Boolean(resumeTranscript && resumeTranscript.length > 0);

  if (!messages.some((m) => m.role === 'system')) {
    const skills = skillsSection?.trim() ? `\n\n${skillsSection.trim()}` : '';
    messages.push({
      role: 'system',
      content: `${lemcoreSystemPrompt()}${skills}\n\n${task.title}${task.prompt ? `\n${task.prompt}` : ''}`,
    });
  }
  if (!messages.some((m) => m.role === 'user')) {
    messages.push({ role: 'user', content: prompt });
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
  // Stall watchdog for a single LLM turn (LEMCORE_STALLED_TURN_TIMEOUT_MINUTES
  // by default): a hung provider aborts the run fast instead of pinning the
  // worker slot until the wall-clock cap fires.
  const perTurnTimeoutMs = turnTimeoutMs(opts);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
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
    // Budget enforcement only when the LLM config sets one (the runtime is
    // seeded with the task's cumulative usage, so a configured budget spans
    // the whole task). No implicit default — large tasks must not be
    // killed by a hidden cap; the compaction cap bounds per-turn cost.
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
        messages: toChatMessages(messages),
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
    // A non-empty text reply without tool calls is the agent's final answer.
    if (!hasToolCalls && result.content.trim().length > 0) {
      saveTranscript(workdir, messages);
      return result.content;
    }
    // An empty reply is never a legitimate final answer — some providers
    // (e.g. z.ai GLM) return finish_reason "stop" with an empty message when
    // the reasoning budget is consumed. Nudge and continue; abort the run
    // (visible failure) instead of silently ending as 'done' with no changes.
    if (!hasToolCalls) {
      consecutiveEmptyReplies += 1;
      if (consecutiveEmptyReplies >= MAX_EMPTY_ASSISTANT_REPLIES) {
        throw new Error(
          `lemcore agent stopped: the LLM returned ${consecutiveEmptyReplies} ` +
            'consecutive empty replies (no content, no tool calls)',
        );
      }
      await publishStepEvent(taskId, {
        stepId: nextStepId(),
        status: 'done',
        kind: 'assistant',
        title: 'Empty LLM reply — nudging the model',
        detail:
          `Provider returned no content and no tool calls ` +
          `(${consecutiveEmptyReplies}/${MAX_EMPTY_ASSISTANT_REPLIES}); asking the model to continue.`,
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
    });
    saveTranscript(workdir, messages);
  }

  const lastMsg = messages[messages.length - 1];
  return lastMsg?.content ?? '';
}
