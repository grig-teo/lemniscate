import { parseToolCallArguments, type ChatToolCall } from '../llm-client.js';
import {
  toolReadFile,
  toolWriteFile,
  toolEditFile,
  toolBash,
  toolGrep,
  toolGlob,
  toolWebSearch,
  type ToolResult,
  type ToolName,
} from './tools.js';
import { MAX_TOOL_FAILURES } from './loop-constants.js';
import type { LemcoreMessage, LemcoreStep } from './loop-types.js';

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
  secrets: string[],
): Promise<ToolResult> {
  switch (name) {
    case 'read_file':
      return toolReadFile(
        workdir,
        String(args.path ?? ''),
        args.offset !== undefined ? Number(args.offset) : undefined,
        args.limit !== undefined ? Number(args.limit) : undefined,
        secrets,
      );
    case 'write_file':
      return toolWriteFile(workdir, String(args.path ?? ''), String(args.content ?? ''), secrets);
    case 'edit_file':
      return toolEditFile(
        workdir,
        String(args.path ?? ''),
        String(args.search ?? ''),
        String(args.replace ?? ''),
        secrets,
      );
    case 'bash':
      return toolBash(workdir, String(args.command ?? ''), secrets);
    case 'grep':
      return toolGrep(
        workdir,
        String(args.pattern ?? ''),
        args.path !== undefined ? String(args.path) : undefined,
        args.glob !== undefined ? String(args.glob) : undefined,
        secrets,
      );
    case 'glob':
      return toolGlob(workdir, String(args.pattern ?? ''), secrets);
    case 'web_search':
      return toolWebSearch(String(args.query ?? ''), secrets);
    default:
      return {
        tool: name as ToolName,
        title: name,
        outputPreview: `unknown tool: ${name}`,
        durationMs: 0,
        error: `unknown tool: ${name}`,
      };
  }
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const hint = args.path ?? args.command ?? args.pattern ?? args.query ?? '';
  const hintText = hint === undefined || hint === null ? '' : String(hint);
  return hintText ? `${name}(${hintText})` : name;
}

export async function runToolCalls(opts: {
  taskId: string;
  workdir: string;
  secrets: string[];
  toolCalls: ChatToolCall[];
  messages: LemcoreMessage[];
  consecutiveToolFailures: number;
  nextStepId: () => string;
  publishStepEvent: (taskId: string, step: LemcoreStep) => Promise<void>;
}): Promise<number> {
  let failures = opts.consecutiveToolFailures;
  for (const tc of opts.toolCalls) {
    const name = tc.function.name;
    const toolStepId = opts.nextStepId();
    let args: Record<string, unknown>;
    try {
      args = parseToolCallArguments(tc.function.arguments);
    } catch (err) {
      failures = await pushToolError({
        opts,
        tc,
        name,
        toolStepId,
        failures,
        msg: (err as Error).message,
        corrective: true,
      });
      continue;
    }

    const toolStep: LemcoreStep = {
      stepId: toolStepId,
      status: 'running',
      kind: 'tool',
      tool: name,
      title: toolTitle(name, args),
    };
    await opts.publishStepEvent(opts.taskId, toolStep);
    const toolStart = Date.now();
    try {
      const result = await executeTool(name, args, opts.workdir, opts.secrets);
      const durationMs = Date.now() - toolStart;
      if (result.error) {
        failures += 1;
        toolStep.status = 'error';
        toolStep.outputPreview = result.outputPreview || result.error;
        toolStep.detail = result.detail;
        toolStep.durationMs = durationMs;
        await opts.publishStepEvent(opts.taskId, toolStep);
        opts.messages.push({
          role: 'tool',
          content: `Error: ${result.error}\n${result.outputPreview}`,
          toolCallId: tc.id,
          toolName: name,
        });
      } else {
        failures = 0;
        toolStep.status = 'done';
        toolStep.outputPreview = result.outputPreview;
        toolStep.detail = result.detail;
        toolStep.durationMs = durationMs;
        await opts.publishStepEvent(opts.taskId, toolStep);
        opts.messages.push({
          role: 'tool',
          content: result.outputPreview,
          toolCallId: tc.id,
          toolName: name,
        });
      }
    } catch (err) {
      failures = await pushToolError({
        opts,
        tc,
        name,
        toolStepId,
        failures,
        msg: (err as Error).message,
        durationMs: Date.now() - toolStart,
        toolStep,
      });
    }
    if (failures >= MAX_TOOL_FAILURES) {
      throw new Error(`Too many consecutive tool failures (${failures}); aborting lemcore run`);
    }
  }
  return failures;
}

async function pushToolError(input: {
  opts: {
    taskId: string;
    messages: LemcoreMessage[];
    publishStepEvent: (taskId: string, step: LemcoreStep) => Promise<void>;
  };
  tc: ChatToolCall;
  name: string;
  toolStepId: string;
  failures: number;
  msg: string;
  corrective?: boolean;
  durationMs?: number;
  toolStep?: LemcoreStep;
}): Promise<number> {
  const failures = input.failures + 1;
  const step =
    input.toolStep ??
    ({
      stepId: input.toolStepId,
      status: 'error',
      kind: 'tool',
      tool: input.name,
      title: input.name,
      outputPreview: input.msg,
    } satisfies LemcoreStep);
  step.status = 'error';
  step.outputPreview = input.msg.slice(0, 1_000);
  if (input.durationMs !== undefined) step.durationMs = input.durationMs;
  await input.opts.publishStepEvent(input.opts.taskId, step);
  const content = input.corrective
    ? `Error: ${input.msg}. Resend the tool call with a JSON object for arguments.`
    : `Error: ${input.msg}`;
  input.opts.messages.push({
    role: 'tool',
    content,
    toolCallId: input.tc.id,
    toolName: input.name,
  });
  if (failures >= MAX_TOOL_FAILURES) {
    throw new Error(`Too many consecutive tool failures (${failures}); aborting lemcore run`);
  }
  return failures;
}
