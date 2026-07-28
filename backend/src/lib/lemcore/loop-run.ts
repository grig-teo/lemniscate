import fs from 'node:fs';
import path from 'node:path';
import { publishTaskEvent } from '../task-events.js';
import type { LemcoreStep, LemcoreMessage, LemcoreRunOptions } from './loop-types.js';
import { MAX_TURNS, MAX_TOOL_FAILURES, TRANSCRIPT_FILE, REVIEW_FILENAME, lemcoreSystemPrompt } from './loop-constants.js';
import { executeToolCall, loadTranscript, saveTranscript, checkReviewFile } from './loop-helpers.js';
import type { ChatMessage } from '../llm-client.js';
import { chatCompletions } from '../llm-client.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import { redactSecrets } from '../utils.js';
import { toolReadFile, toolWriteFile, toolEditFile, toolBash, toolGrep, toolGlob, toolWebSearch } from './tools.js';
import type { ToolResult } from './tools.js';

let stepCounter = 0;
export function nextStepId(): string {
  return `step-${++stepCounter}`;
}

export async function publishStepEvent(taskId: string, step: LemcoreStep): Promise<void> {
  await publishTaskEvent(taskId, 'agent_step' as any, {
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

export async function loadTranscriptSafe(workdir: string): Promise<LemcoreMessage[] | null> {
  return loadTranscript(workdir);
}

export async function saveTranscriptSafe(workdir: string, messages: LemcoreMessage[]): Promise<void> {
  saveTranscript(workdir, messages);
}

export async function checkReviewFileSafe(workdir: string): Promise<boolean> {
  return checkReviewFile(workdir);
}

export function lemcoreSystemPrompt(): string {
  return lemcoreSystemPrompt();
}