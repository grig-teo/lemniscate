import { config } from '../config.js';
import { publishTaskEvent } from '../task-events.js';
import { redactSecrets } from '../utils.js';
import { chatCompletions, type ChatMessage } from '../llm-client.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
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
