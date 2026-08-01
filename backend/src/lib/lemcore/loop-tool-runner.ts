import { parseToolCallArguments, type ChatToolCall } from '../llm-client.js';
import type { LlmRuntime } from '../agent-runtime.js';
import {
  toolReadFile,
  toolWriteFile,
  toolEditFile,
  toolMultiEdit,
  toolBash,
  type ToolResult,
  type ToolName,
} from './tools.js';
import { toolUndoEdit } from './edit-checkpoint.js';
import { toolTodoWrite } from './todo-store.js';
import {
  toolGrep,
  toolGlob,
  toolListDir,
  toolWebSearch,
} from './explore-tools.js';
import {
  toolGraphImpact,
  toolGraphNeighbors,
  toolGraphQuery,
  toolGraphSearch,
} from './graph-tools.js';
import { MAX_TOOL_FAILURES } from './loop-constants.js';
import type { LemcoreMessage, LemcoreStep } from './loop-types.js';
import { resolveSkillContent, type LemcoreSkill } from './skills.js';

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
  secrets: string[],
  skills: LemcoreSkill[] = [],
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
    case 'multi_edit':
      return toolMultiEdit(
        workdir,
        String(args.path ?? ''),
        Array.isArray(args.edits) ? (args.edits as { search: string; replace: string }[]) : [],
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
    case 'list_dir':
      return toolListDir(workdir, String(args.path ?? ''), secrets);
    case 'web_search':
      return toolWebSearch(String(args.query ?? ''), secrets);
    case 'graph_query':
      return toolGraphQuery(workdir, String(args.pattern ?? ''), String(args.target ?? ''));
    case 'graph_impact':
      return toolGraphImpact(workdir, asStringArray(args.files));
    case 'graph_neighbors':
      return toolGraphNeighbors(
        workdir,
        String(args.center ?? ''),
        args.depth !== undefined ? Number(args.depth) : undefined,
      );
    case 'graph_search':
      return toolGraphSearch(workdir, String(args.query ?? ''));
    case 'load_skill': {
      const content = resolveSkillContent(skills, String(args.name ?? ''));
      return {
        tool: 'load_skill' as ToolName,
        title: `load_skill(${String(args.name ?? '')})`,
        outputPreview: content,
        durationMs: 0,
      };
    }
    case 'undo_edit':
      return toolUndoEdit(workdir, String(args.path ?? ''), secrets);
    case 'todo_write':
      return toolTodoWrite(workdir, String(args.content ?? ''), secrets);
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter(Boolean);
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const hint =
    args.path ??
    args.command ??
    args.pattern ??
    args.query ??
    args.target ??
    args.center ??
    (Array.isArray(args.files) ? args.files[0] : '') ??
    '';
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
  skills?: LemcoreSkill[];
  rt?: LlmRuntime;
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
      const result = await executeTool(name, args, opts.workdir, opts.secrets, opts.skills ?? []);
      const durationMs = Date.now() - toolStart;
      if (result.error) {
        // web_search is best-effort: a flaky DDG page should never count
        // toward MAX_TOOL_FAILURES and abort a coding task. The model still
        // receives the error message and can retry or proceed. Graph tools are
        // likewise soft failures: a repo with no built graph (the common case)
        // would otherwise exhaust MAX_TOOL_FAILURES in two calls even though
        // the system prompt actively says to "Prefer graph_query...".
        const graphTools = new Set([
          'graph_query',
          'graph_impact',
          'graph_neighbors',
          'graph_search',
        ]);
        if (name !== 'web_search' && !graphTools.has(name)) failures += 1;
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
