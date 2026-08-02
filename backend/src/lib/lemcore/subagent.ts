// Read-only investigator subagent: a lightweight child agent loop with
// read-only tools (no write/edit/bash). Investigates a question and returns
// a distilled summary to the parent, keeping the parent's context lean.
// Pattern: Claude Code's read-only subagents / Cognition's recommendation.
import { chatCompletion } from '../llm-dispatch.js';
import { config } from '../../config.js';
import { logEvent } from '../agent-git.js';
import { PROMPT_INJECTION_GUARD } from '../prompt-guards.js';
import { getReadOnlyTools } from './tool-catalog.js';
import { runToolCalls } from './loop-tool-runner.js';
import { classifyAssistantReply, EMPTY_REPLY_NUDGE } from './loop-reply.js';
import { MAX_EMPTY_ASSISTANT_REPLIES } from './loop-constants.js';
import { chatWithTurnTimeout, turnTimeoutMs } from './loop-types.js';
import type { LemcoreMessage, LemcoreRunOptions } from './loop-types.js';
import { makeLlmRuntime, type LlmRuntime } from '../agent-runtime.js';
import type { ChatToolCall } from '../llm-client.js';
import type { ToolResult, ToolName } from './tools.js';

const SUBAGENT_SYSTEM_PROMPT = [
  'You are a read-only code investigator.',
  'Answer the question using the read tools available to you (read_file, grep, glob, list_dir, graph_*, web_search).',
  'You CANNOT modify files, run bash, or write code — you are investigating only.',
  'Be thorough: search, read, and explore until you have a confident answer.',
  'Finish with a concise, factual summary of your findings. Do not speculate.',
  PROMPT_INJECTION_GUARD,
].join('\n');

export interface SubagentCtx {
  rt: LlmRuntime;
  taskId: string;
  toolCall: ChatToolCall;
}

/**
 * Tool-facing wrapper for the spawn_subagent tool. Respects the
 * LEMCORE_SUBAGENT_ENABLED flag, handles the no-context case, and rolls the
 * child's token usage back into the parent runtime so subagent cost counts
 * against the parent's budget (the previous implementation leaked child
 * tokens — a subagent could spend 20k tokens without touching the ceiling).
 */
export async function spawnSubagentTool(
  ctx: SubagentCtx | undefined,
  workdir: string,
  secrets: string[],
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx) return noSubagentContext();
  if (!config.LEMCORE_SUBAGENT_ENABLED) {
    return {
      tool: 'spawn_subagent' as ToolName, title: 'spawn_subagent', durationMs: 0,
      outputPreview: 'Subagents are disabled (LEMCORE_SUBAGENT_ENABLED=false).',
    };
  }
  const prompt = String(args.prompt ?? '');
  const start = Date.now();
  try {
    const summary = await runSubagent({ rt: ctx.rt, workdir, secrets, taskId: ctx.taskId, prompt });
    return {
      tool: 'spawn_subagent' as ToolName,
      title: `spawn_subagent(${prompt.slice(0, 40)})`,
      outputPreview: summary, durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      tool: 'spawn_subagent' as ToolName, title: 'spawn_subagent',
      outputPreview: `Subagent failed: ${(err as Error).message}`,
      durationMs: Date.now() - start, error: `subagent error: ${(err as Error).message}`,
    };
  }
}

function noSubagentContext(): ToolResult {
  return {
    tool: 'spawn_subagent' as ToolName, title: 'spawn_subagent', durationMs: 0,
    outputPreview: 'Subagent unavailable (no runtime context).',
    error: 'spawn_subagent requires runtime context',
  };
}

export async function runSubagent(opts: {
  rt: LlmRuntime;
  workdir: string;
  prompt: string;
  secrets: string[];
  taskId: string;
  maxTurns?: number;
}): Promise<string> {
  const { rt: parentRt, workdir, prompt, secrets, taskId } = opts;
  const maxTurns = opts.maxTurns ?? config.LEMCORE_SUBAGENT_MAX_TURNS;
  // Child shares the parent's cfg/apiKey but has its own token counter; the
  // child's usage is rolled back into the parent below so it counts against
  // the parent's budget (cost ceiling cannot be bypassed via a subagent).
  const childRt = makeLlmRuntime(parentRt.cfg, parentRt.apiKey);
  try {
    return await runSubagentLoop({ childRt, workdir, prompt, secrets, taskId, maxTurns });
  } finally {
    parentRt.usedTokens += childRt.usedTokens;
    parentRt.usedPromptTokens += childRt.usedPromptTokens;
    parentRt.usedCompletionTokens += childRt.usedCompletionTokens;
  }
}

async function runSubagentLoop(opts: {
  childRt: LlmRuntime;
  workdir: string;
  prompt: string;
  secrets: string[];
  taskId: string;
  maxTurns: number;
}): Promise<string> {
  const { childRt, workdir, prompt, secrets, taskId, maxTurns } = opts;
  const messages: LemcoreMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  let consecutiveEmpty = 0;
  let stepCounter = 0;
  const nextStepId = () => `subagent-${taskId}-${++stepCounter}`;
  const perTurnTimeoutMs = turnTimeoutMs({} as LemcoreRunOptions);
  const publishStep = async (_taskId: string, _step: unknown): Promise<void> => {};

  for (let turn = 0; turn < maxTurns; turn++) {
    const result = await chatWithTurnTimeout(turn + 1, perTurnTimeoutMs, () =>
      chatCompletion({
        baseUrl: childRt.cfg.baseUrl,
        apiKey: childRt.apiKey,
        model: childRt.cfg.model,
        apiPattern: childRt.cfg.apiPattern,
        messages: messages as never,
        maxTokens: Math.min(Math.max(childRt.cfg.maxTokens ?? 8_192, 4_096), 32_768),
        temperature: childRt.cfg.temperature ?? 0.2,
        tools: getReadOnlyTools(),
      }),
    );
    childRt.usedTokens += result.usage?.totalTokens ?? 0;
    childRt.usedPromptTokens += result.usage?.promptTokens ?? 0;
    childRt.usedCompletionTokens += result.usage?.completionTokens ?? 0;
    const content = result.content ?? '';
    const toolCalls = result.toolCalls ?? [];
    messages.push({ role: 'assistant', content, toolCalls });

    const action = classifyAssistantReply(toolCalls.length > 0, content, consecutiveEmpty);
    if (action.kind === 'final') return content;
    if (action.kind === 'abort') return content || 'Investigation incomplete (no reply from model).';
    if (action.kind === 'nudge') {
      consecutiveEmpty = action.count;
      messages.push({ role: 'user', content: EMPTY_REPLY_NUDGE });
      continue;
    }
    consecutiveEmpty = 0;
    await runToolCalls({
      taskId, workdir, secrets,
      toolCalls, messages,
      consecutiveToolFailures: 0,
      nextStepId, publishStepEvent: publishStep,
    });
  }
  await logEvent(taskId, `subagent: reached ${maxTurns}-turn cap, returning best summary`);
  const lastContent = messages[messages.length - 1]?.content ?? '';
  return lastContent || 'Investigation incomplete (turn limit reached).';
}
