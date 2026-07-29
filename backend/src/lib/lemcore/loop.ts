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
  TRANSCRIPT_FILE,
  REVIEW_FILENAME,
  lemcoreSystemPrompt,
} from './loop-constants.js';
import type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';
import { getAvailableTools } from './tool-catalog.js';
import { runToolCalls } from './loop-tool-runner.js';

export { MAX_TURNS, MAX_TOOL_FAILURES, TRANSCRIPT_FILE, REVIEW_FILENAME, lemcoreSystemPrompt } from './loop-constants.js';
export type { LemcoreMessage, LemcoreRunOptions, LemcoreStep } from './loop-types.js';

let stepCounter = 0;
function nextStepId(): string {
  return `step-${++stepCounter}`;
}

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

export function loadTranscript(workdir: string): LemcoreMessage[] | null {
  const file = path.join(workdir, TRANSCRIPT_FILE);
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
  const file = path.join(workdir, TRANSCRIPT_FILE);
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
  const { taskId, task, workdir, rt, prompt, secrets, resumeTranscript } = opts;
  const messages: LemcoreMessage[] = resumeTranscript ? [...resumeTranscript] : [];

  if (!messages.some((m) => m.role === 'system')) {
    messages.push({
      role: 'system',
      content: `${lemcoreSystemPrompt()}\n\n${task.title}${task.prompt ? `\n${task.prompt}` : ''}`,
    });
  }
  if (!messages.some((m) => m.role === 'user')) {
    messages.push({ role: 'user', content: prompt });
  }
  saveTranscript(workdir, messages);

  let consecutiveToolFailures = 0;
  const startTime = Date.now();
  const wallClockCapMs = config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() - startTime > wallClockCapMs) {
      throw new Error(`lemcore agent timed out after ${Math.round(wallClockCapMs / 1000)}s`);
    }

    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
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
    const result = await chatCompletion({
      baseUrl: rt.cfg.baseUrl,
      apiKey: rt.apiKey,
      model: rt.cfg.model,
      apiPattern: rt.cfg.apiPattern,
      messages: toChatMessages(messages),
      maxTokens: Math.min(rt.cfg.maxTokens ?? 4096, 4096),
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
    });

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
    if (!hasToolCalls) {
      saveTranscript(workdir, messages);
      return result.content;
    }

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
