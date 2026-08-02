import { parseToolCallArguments, type ChatToolCall } from '../llm-client.js';
import type { LlmRuntime } from '../agent-runtime.js';
import {
  toolReadFile,
  toolWriteFile,
  toolBash,
  toolThink,
  type ToolResult,
  type ToolName,
} from './tools.js';
import { applySingleEdit, applyMultiEdit } from './edit-helpers.js';
import { runEdit } from './edit-router.js';
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
import type { LemcoreMessage, LemcoreStep } from './loop-types.js';
import { assertFilePathArg } from './path-arg-guard.js';
import { resolveSkillContent, type LemcoreSkill } from './skills.js';

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
  secrets: string[],
  skills: LemcoreSkill[] = [],
  multiSampleCtx?: { rt: LlmRuntime; taskId: string; toolCall: ChatToolCall },
): Promise<ToolResult> {
  const pathError = assertFilePathArg(name, args);
  if (pathError) return pathError;
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
      return runEdit('edit_file', String(args.path ?? ''), workdir, secrets, multiSampleCtx, (original) =>
        applySingleEdit(String(args.path ?? ''), original, String(args.search ?? ''), String(args.replace ?? '')),
      );
    case 'multi_edit':
      return runEdit('multi_edit', String(args.path ?? ''), workdir, secrets, multiSampleCtx, (original) =>
        applyMultiEdit(
          String(args.path ?? ''),
          original,
          Array.isArray(args.edits) ? (args.edits as { search: string; replace: string }[]) : [],
        ),
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
    case 'think':
      return toolThink(String(args.thought ?? ''));
    case 'spawn_subagent': {
      const { spawnSubagentTool } = await import('./subagent.js');
      return spawnSubagentTool(multiSampleCtx, workdir, secrets, args);
    }
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
      // todo_write carries the parsed checklist in `detail` for the panel.
      ...(name === 'todo_write' ? { subtype: 'todo' as const } : {}),
    };
    await opts.publishStepEvent(opts.taskId, toolStep);
    const toolStart = Date.now();
    try {
      // Thread the runtime + per-call context through to executeTool so tools
      // that need it (spawn_subagent, multi-sample edit verification) actually
      // receive it. Without this, multiSampleCtx is always undefined and both
      // features silently hit their "no runtime context" early returns.
      const multiSampleCtx = opts.rt
        ? { rt: opts.rt, taskId: opts.taskId, toolCall: tc }
        : undefined;
      const result = await executeTool(name, args, opts.workdir, opts.secrets, opts.skills ?? [], multiSampleCtx);
      const durationMs = Date.now() - toolStart;
      if (result.error) {
        // Tool failures never abort the run — the model sees the error and
        // can retry or reroute. The counter is kept only so the loop can
        // detect a fully-successful batch (it resets other nudge counters).
        // web_search is best-effort: a flaky DDG page shouldn't count as a
        // failure. Graph tools are likewise soft: a repo with no built graph
        // (the common case) would otherwise look like repeated failures even
        // though the system prompt actively says to "Prefer graph_query...".
        const graphTools = new Set([
          'graph_query',
          'graph_impact',
          'graph_neighbors',
          'graph_search',
        ]);
        // spawn_subagent is also soft: a child failure shouldn't count against the parent.
        if (name !== 'web_search' && !graphTools.has(name) && name !== 'spawn_subagent') failures += 1;
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
        toolStep.diff = result.diff;
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
    // No abort on repeated failures — tools may fail an unlimited number of
    // times; the model keeps seeing the errors and can reroute.
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
  return failures;
}
