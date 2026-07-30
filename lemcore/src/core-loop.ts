// Platform-agnostic lemcore agent loop (@lemniscate/core, Phase 9 §7).
// All platform services (LLM HTTP, step persistence, plan/tool approvals,
// steering, MCP sessions) sit behind ports in ports.ts, so this module runs
// identically in the backend worker and the standalone CLI.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type {
  CoreChatMessage,
  CoreLlmClient,
  CoreStep,
  CoreTokenUsage,
  CoreToolCall,
} from './core-types.js';
import type { CoreLoopAdapters } from './ports.js';
import { ToolRegistry, loadPluginTools } from './plugin-tools.js';
import { lemcoreSystemPrompt, transcriptPath } from './loop-constants.js';
import { compactTranscript, shouldCompactTranscript } from './loop-compact.js';
import { loadMcpTools } from './loop-mcp.js';
import { builtinTools } from './builtin-tools.js';
import { toolBash } from './tools.js';
import { errorMessage } from './utils.js';

export interface CoreRunOptions {
  workdir: string;
  prompt: string;
  client: CoreLlmClient;
  contextWindow: number | null;
  maxTokens: number;
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  secrets: string[];
  maxTurns: number;
  /** Extra system prompt section (skills summaries, memory, repo context). */
  systemExtra?: string;
  /** Hard wall-clock deadline (epoch ms); loop exits gracefully past it. */
  deadlineMs?: number;
  adapters: CoreLoopAdapters;
}

export interface CoreRunResult {
  summary: string;
  turns: number;
  tokensUsed: number;
  /** Set when the model wrote .lemniscate-review.json (verified verdict). */
  review: Record<string, unknown> | null;
  /** True when the loop ran out of turns/deadline without a final answer. */
  truncated: boolean;
}

const bashEcho = (cmd: string): string => {
  const pretty = cmd.replace(/\s*\n\s*/g, ' ').trim();
  return pretty.length > 120 ? `${pretty.slice(0, 120)}…` : pretty;
};

export async function runCoreLoop(opts: CoreRunOptions): Promise<CoreRunResult> {
  const { adapters } = opts;
  const registry = new ToolRegistry();
  for (const def of builtinTools(opts.secrets)) registry.register(def);
  for (const def of (await adapters.pluginTools?.()) ?? []) registry.register(def);
  const mcp = await loadMcpTools(opts.workdir, opts.secrets, adapters, registry);
  const messages: CoreChatMessage[] = [
    {
      role: 'system',
      content: lemcoreSystemPrompt(opts.workdir) + (opts.systemExtra ? `\n\n${opts.systemExtra}` : ''),
    },
    { role: 'user', content: opts.prompt },
  ];
  adapters.saveTranscript?.(messages);
  const tokens: CoreTokenUsage = { prompt: 0, completion: 0 };
  let turns = 0;
  let consecutiveToolFailures = 0;
  let truncated = false;
  try {
    for (;;) {
      if (turns >= opts.maxTurns || (opts.deadlineMs && Date.now() > opts.deadlineMs)) {
        truncated = true;
        await runBashBestEffort(opts.workdir, opts.maxTurns, turns);
        break;
      }
      turns += 1;
      for (const note of await adapters.pollSteer()) {
        messages.push({ role: 'user', content: `[steering] ${note}` });
      }
      const response = await callModel(opts, messages, registry, tokens);
      const stepBase = { turn: turns, status: 'done' as const };
      if (response.content.trim()) {
        await adapters.emitStep({
          ...stepBase,
          stepId: crypto.randomUUID(),
          kind: 'assistant',
          title: response.content.slice(0, 200),
          tokensUsed: tokens.prompt + tokens.completion,
        });
      }
      messages.push({
        role: 'assistant',
        content: response.content,
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });
      adapters.saveTranscript?.(messages);
      if (response.toolCalls.length === 0) break;
      for (const call of response.toolCalls) {
        const result = await runToolCall(opts, registry, call, turns);
        consecutiveToolFailures = result.error ? consecutiveToolFailures + 1 : 0;
        if (consecutiveToolFailures >= 2) {
          messages.push({
            role: 'user',
            content:
              'Repeated tool failures. Stop retrying the same approach: diagnose ' +
              'the root cause, change strategy, or report the blocker.',
          });
          consecutiveToolFailures = 0;
        }
      }
      adapters.saveTranscript?.(messages);
    }
  } finally {
    await mcp?.cleanup().catch(() => undefined);
  }
  return {
    summary: lastAssistantText(messages),
    turns,
    tokensUsed: tokens.prompt + tokens.completion,
    review: await readReviewFile(opts.workdir),
    truncated,
  };
}

async function callModel(
  opts: CoreRunOptions,
  messages: CoreChatMessage[],
  registry: ToolRegistry,
  tokens: CoreTokenUsage,
): Promise<{ content: string; toolCalls: CoreToolCall[] }> {
  const wire = shouldCompactTranscript(messages, opts.contextWindow)
    ? compactTranscript(messages)
    : messages;
  const res = await opts.client.chatCompletion({
    messages: wire,
    tools: registry.list(),
    maxTokens: opts.maxTokens,
    thinkingLevel: opts.thinkingLevel,
  });
  tokens.prompt += res.usage.prompt;
  tokens.completion += res.usage.completion;
  if (shouldCompactTranscript(messages, opts.contextWindow)) {
    messages.splice(0, messages.length, ...wire);
  }
  return res;
}

async function runToolCall(
  opts: CoreRunOptions,
  registry: ToolRegistry,
  call: CoreToolCall,
  turn: number,
): Promise<{ error?: string }> {
  const { adapters } = opts;
  const args = parseArgs(call.arguments);
  const step: CoreStep = {
    stepId: crypto.randomUUID(),
    status: 'running',
    kind: 'tool',
    tool: call.name,
    title: call.name === 'bash' ? bashEcho(String(args.command ?? '')) : call.name,
    ...(args.path !== undefined ? { detail: String(args.path) } : {}),
    turn,
  };
  await adapters.emitStep(step);
  if (registry.isMutating(call.name)) {
    const approved = await adapters.approveToolCall({
      stepId: step.stepId,
      tool: call.name,
      title: step.title,
      args,
    });
    if (!approved) {
      return finishToolStep(opts, call, step, {
        tool: call.name,
        title: step.title,
        outputPreview: 'denied by user',
        durationMs: 0,
        error: 'denied by user',
      });
    }
  }
  let result;
  try {
    result = await registry.execute(call.name, args, { workdir: opts.workdir });
  } catch (err) {
    result = {
      tool: call.name,
      title: step.title,
      outputPreview: errorMessage(err).slice(0, 8_000),
      durationMs: 0,
      error: errorMessage(err).slice(0, 500),
    };
  }
  return finishToolStep(opts, call, step, result);
}

async function finishToolStep(
  opts: CoreRunOptions,
  call: CoreToolCall,
  step: CoreStep,
  result: { outputPreview: string; durationMs: number; error?: string },
): Promise<{ error?: string }> {
  await opts.adapters.emitStep({
    ...step,
    status: result.error ? 'error' : 'done',
    outputPreview: result.outputPreview,
    durationMs: result.durationMs,
    error: result.error,
  });
  opts.adapters.appendToolMessage({
    role: 'tool',
    toolCallId: call.id,
    toolName: call.name,
    content: result.error
      ? `error: ${result.error}\n${result.outputPreview}`
      : result.outputPreview,
  });
  return { ...(result.error ? { error: result.error } : {}) };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function lastAssistantText(messages: CoreChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === 'assistant' && m.content.trim()) return m.content.trim();
  }
  return '';
}

/** Out of turns: leave a structured note for the reviewer in the workdir. */
async function runBashBestEffort(workdir: string, maxTurns: number, turns: number): Promise<void> {
  const dir = path.dirname(transcriptPath(workdir));
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
  await toolBash(
    workdir,
    `echo "lemcore stopped after ${turns}/${maxTurns} turns — incomplete" > .lemniscate-status.txt`,
  );
}

async function readReviewFile(workdir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(path.join(workdir, '.lemniscate-review.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
