// Structured agent loop for the lemcore executor.
// Replaces the raw hermes CLI subprocess with a typed TypeScript loop:
// system prompt + user prompt + workdir + LlmRuntime; up to MAX_TURNS
// assistant↔tool rounds. Stops when the model answers with no tool calls.
//
// Emits structured `agent_step` events (not raw log lines) via publishTaskEvent.
// Persists the loop transcript to the task workdir for resume support.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { publishTaskEvent } from '../task-events.js';
import { redactSecrets } from '../utils.js';
import { chatCompletions } from '../llm-client.js';
import type { ChatMessage } from '../llm-client.js';
import type { LlmRuntime, TaskWithRepo } from '../agent-runtime.js';
import {
  toolReadFile,
  toolWriteFile,
  toolEditFile,
  toolBash,
  toolGrep,
  toolGlob,
  toolWebSearch,
  type ToolResult,
  TOOL_MAX_OUTPUT_CHARS,
} from './tools.js';

export const MAX_TURNS = 60;
export const MAX_TOOL_FAILURES = 2;
export const TRANSCRIPT_FILE = 'lemcore-transcript.json';
export const REVIEW_FILENAME = '.lemniscate-review.json';

export interface LemcoreStep {
  stepId: string;
  status: 'running' | 'done' | 'error';
  kind: 'assistant' | 'tool';
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
}

export interface LemcoreRunOptions {
  taskId: string;
  task: TaskWithRepo;
  workdir: string;
  rt: LlmRuntime;
  prompt: string;
  secrets: string[];
  resumeTranscript?: LemcoreMessage[];
}

export interface LemcoreMessage {
  role: 'system' | 'user' | 'assistant' | 'tool-result';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

export const MAX_TURNS = 60;
export const MAX_TOOL_FAILURES = 2;
export const TRANSCRIPT_FILE = 'lemcore-transcript.json';
export const REVIEW_FILENAME = '.lemniscate-review.json';

export interface LemcoreStep {
  stepId: string;
  status: 'running' | 'done' | 'error';
  kind: 'assistant' | 'tool';
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
}

export interface LemcoreRunOptions {
  taskId: string;
  task: TaskWithRepo;
  workdir: string;
  rt: LlmRuntime;
  prompt: string;
  secrets: string[];
  resumeTranscript?: LemcoreMessage[];
}

export interface LemcoreMessage {
  role: 'system' | 'user' | 'assistant' | 'tool-result';
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
}

let stepCounter = 0;
function nextStepId(): string {
  return `step-${++stepCounter}`;
}

async function publishStepEvent(
  taskId: string,
  step: LemcoreStep,
): Promise<void> {
  await publishTaskEvent(taskId, 'agent_step' as any, {
    stepId: step.stepId,
    status: step.status,
    kind: step.kind,
    tool: step.tool,
    title: step.title,
    detail: step.detail,
    outputPreview: step.outputPreview
      ? step.outputPreview.slice(0, 2_000)
      : undefined,
    durationMs: step.durationMs,
    tokensUsed: step.tokensUsed,
  });
}

// Build the full system prompt: HERMES_INSTRUCTIONS base + tool-usage section.
export function lemcoreSystemPrompt(): string {
  const hermesInstructions =
    'Work in the current directory. Implement the task completely, including tests if the project has a test setup. Respect the repository\'s own rules (AGENTS.md, lint/size guards) and keep any repo-provided checks (e.g. check:max-lines, lint scripts) passing — split modules instead of growing files past a size limit. Do NOT git commit, push, or create branches — git is handled externally.';
  return [
    hermesInstructions,
    '',
    'You have access to the following tools. Use them to read, write, and explore files.',
    '- read_file(path, offset?, limit?): read a file',
    '- write_file(path, content): overwrite a file',
    '- edit_file(path, search, replace): literal search/replace, exactly one match required',
    '- bash(command): run a shell command (120s timeout)',
    '- grep(pattern, path?, glob?): search with ripgrep',
    '- glob(pattern): list files matching a pattern (max 200)',
    '- web_search(query): search the web (Phase 2)',
    '',
    'Use tools in a structured way. Prefer reading before writing. After making changes, verify them.',
  ].join('\n');
}

export function loadTranscript(workdir: string): LemcoreMessage[] | null {
  const file = path.join(workdir, TRANSCRIPT_FILE);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // no transcript or malformed — return null
  }
  return null;
}

function saveTranscript(workdir: string, messages: LemcoreMessage[]): void {
  const file = path.join(workdir, TRANSCRIPT_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
  fs.renameSync(tmp, file);
}

// Check if .lemniscate-review.json exists with a valid verdict.
export async function checkReviewFile(workdir: string): Promise<boolean> {
  const file = path.join(workdir, REVIEW_FILENAME);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.verdict === 'string';
  } catch {
    return false;
  }
}

// Execute a single tool call by name with its arguments.
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workdir: string,
  secrets: string[],
): Promise<ToolResult> {
  switch (name) {
    case 'read_file': {
      const filePath = String(args.path ?? '');
      const offset = args.offset !== undefined ? Number(args.offset) : undefined;
      const limit = args.limit !== undefined ? Number(args.limit) : undefined;
      return toolReadFile(workdir, filePath, offset, limit, secrets);
    }
    case 'write_file': {
      const filePath = String(args.path ?? '');
      const content = String(args.content ?? '');
      return toolWriteFile(workdir, filePath, content, secrets);
    }
    case 'edit_file': {
      const filePath = String(args.path ?? '');
      const search = String(args.search ?? '');
      const replace = String(args.replace ?? '');
      return toolEditFile(workdir, filePath, search, replace, secrets);
    }
    case 'bash': {
      const command = String(args.command ?? '');
      return toolBash(workdir, command, secrets);
    }
    case 'grep': {
      const pattern = String(args.pattern ?? '');
      const pathArg = args.path !== undefined ? String(args.path) : undefined;
      const globArg = args.glob !== undefined ? String(args.glob) : undefined;
      return toolGrep(workdir, pattern, pathArg, globArg, secrets);
    }
    case 'glob': {
      const pattern = String(args.pattern ?? '');
      return toolGlob(workdir, pattern, secrets);
    }
    case 'web_search': {
      const query = String(args.query ?? '');
      return toolWebSearch(query, secrets);
    }
    default:
      return {
        tool: name as import('./tools.js').ToolName,
        title: name,
        outputPreview: `unknown tool: ${name}`,
        durationMs: 0,
        error: `unknown tool: ${name}`,
      };
  }
}

// Parse tool_calls from the model's content. Supports two forms:
// 1. A JSON array of tool call objects at the end of the content
// 2. A structured block within the content
function parseToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> | null {
  // Try to find a JSON array containing objects with function.name
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].function?.name) {
        return parsed.map((c: { function: { name: string; arguments: string } }) => ({
          name: c.function.name,
          arguments: JSON.parse(c.function.arguments),
        }));
      }
    } catch {
      // not JSON array
    }
  }
  // Look for a JSON array embedded in content
  const bracketIdx = trimmed.lastIndexOf('[');
  if (bracketIdx !== -1) {
    const slice = trimmed.slice(bracketIdx);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === '[') depth++;
      else if (slice[i] === ']') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx !== -1) {
      try {
        const parsed = JSON.parse(slice.slice(0, endIdx));
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].function?.name) {
          return parsed.map((c: { function: { name: string; arguments: string } }) => ({
            name: c.function.name,
            arguments: JSON.parse(c.function.arguments),
          }));
        }
      } catch {
        // not parseable
      }
    }
  }
  return null;
}

// Run the lemcore agent loop. Returns the assistant's final text content
// (or the content of .lemniscate-review.json when the agent wrote one).
export async function runLemcoreLoop(opts: LemcoreRunOptions): Promise<string> {
  const { taskId, task, workdir, rt, prompt, secrets, resumeTranscript } = opts;

  const messages: LemcoreMessage[] = resumeTranscript ?? [];

  // Add system prompt if not already present
  if (!messages.some((m) => m.role === 'system')) {
    messages.push({
      role: 'system',
      content: `${lemcoreSystemPrompt()}\n\n${opts.task.title}\n${opts.task.prompt ? `\n${opts.task.prompt}` : ''}`,
    });
  }

  // Add user prompt if not already present
  if (!messages.some((m) => m.role === 'user')) {
    messages.push({ role: 'user', content: prompt });
  }

  saveTranscript(workdir, messages);

  let consecutiveToolFailures = 0;
  const startTime = Date.now();
  const wallClockCapMs = config.AGENT_HERMES_TIMEOUT_MINUTES * 60_000;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Wall-clock cap
    if (Date.now() - startTime > wallClockCapMs) {
      throw new Error(`lemcore agent timed out after ${Math.round(wallClockCapMs / 1000)}s`);
    }

    // Token budget check
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    if (rt.cfg.maxTokensPerRun != null && rt.usedTokens + estimatedTokens > rt.cfg.maxTokensPerRun) {
      throw new Error(
        `LLM token budget exceeded (${rt.usedTokens + estimatedTokens} > ${rt.cfg.maxTokensPerRun})`,
      );
    }

    // Assistant turn: call the LLM
    const stepId = nextStepId();
    const assistantStep: LemcoreStep = {
      stepId,
      status: 'running',
      kind: 'assistant',
      title: `Assistant turn ${turn + 1}`,
    };
    await publishStepEvent(taskId, assistantStep);

    const startTimeMs = Date.now();
    const content = await chatCompletions({
      baseUrl: rt.cfg.baseUrl,
      apiKey: rt.cfg.apiKey,
      model: rt.cfg.model,
      messages: messages as ChatMessage[],
      maxTokens: 4096,
      temperature: 0.2,
      tools: getAvailableTools(),
      onRetry: (info) => {
        // Log retries to the task console
        void publishStepEvent(taskId, {
          stepId: `${stepId}-retry-${info.attempt}`,
          status: 'running',
          kind: 'assistant',
          title: `Retry ${info.attempt}`,
          durationMs: info.delayMs,
        });
      },
    });

    const turnDuration = Date.now() - startTimeMs;

    // Check if model returned tool_calls
    const toolCalls = content.toolCalls;
    const hasToolCalls = content.hasToolCalls ?? toolCalls !== undefined;

    // Update the assistant step
    const assistantContent = content.content;
    const preview = assistantContent.slice(0, 500);
    assistantStep.status = 'done';
    assistantStep.detail = preview;
    assistantStep.durationMs = turnDuration;
    assistantStep.tokensUsed = content.usage?.totalTokens;
    await publishStepEvent(taskId, assistantStep);

    // Store the assistant message
    messages.push({ role: 'assistant', content: assistantContent });

    // If the model wrote a review file, extract and return it
    const review = await checkReviewFile(workdir);
    if (review) {
      return assistantContent;
    }

    // If no tool calls, this is the final answer
    if (!hasToolCalls || !toolCalls || toolCalls.length === 0) {
      return assistantContent;
    }

    // Execute each tool call
    for (const tc of toolCalls) {
      const toolStepId = nextStepId();
      const toolStep: LemcoreStep = {
        stepId: toolStepId,
        status: 'running',
        kind: 'tool',
        tool: tc.name,
        title: `${tc.name}(${(tc.arguments as Record<string, unknown>)?.path ?? tc.arguments?.command ?? ''})`,
      };
      await publishStepEvent(taskId, toolStep);

      const toolStart = Date.now();
      try {
        const result = await executeTool(tc.name, tc.arguments as Record<string, unknown>, workdir, secrets);
        const toolDuration = Date.now() - toolStart;
        toolStep.status = 'done';
        toolStep.outputPreview = result.outputPreview;
        toolStep.detail = result.detail;
        toolStep.durationMs = toolDuration;
        consecutiveToolFailures = 0; // reset on success
        await publishStepEvent(taskId, toolStep);
        messages.push({
          role: 'tool-result',
          content: result.outputPreview,
          toolCallId: toolStepId,
          toolName: tc.name,
          toolArgs: tc.arguments,
        });
      } catch (err) {
        const toolDuration = Date.now() - toolStart;
        toolStep.status = 'error';
        toolStep.outputPreview = (err as Error).message.slice(0, 1_000);
        toolStep.durationMs = toolDuration;
        consecutiveToolFailures++;
        await publishStepEvent(taskId, toolStep);
        messages.push({
          role: 'tool-result',
          content: `Error: ${(err as Error).message}`,
          toolCallId: toolStepId,
          toolName: tc.name,
          toolArgs: tc.arguments,
        });
        if (consecutiveToolFailures >= MAX_TOOL_FAILURES) {
          throw new Error(
            `Too many consecutive tool failures (${consecutiveToolFailures}); aborting lemcore run`,
          );
        }
      }
    }

    saveTranscript(workdir, messages);
  }

  // Exhausted max turns — return what we have
  const lastMsg = messages[messages.length - 1];
  return lastMsg?.content ?? '';
}

// Build the OpenAI-compatible tools array from our tool catalog.
function getAvailableTools(): import('../llm-client.js').ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the repository. Optionally specify offset and limit for partial reads.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the file' },
            offset: { type: 'number', description: 'Line offset (0-indexed)' },
            limit: { type: 'number', description: 'Max number of lines' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write (overwrite) a file in the repository.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to write' },
            content: { type: 'string', description: 'Full file content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace exactly one occurrence of search text with replace text in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to the file' },
            search: { type: 'string', description: 'Exact text to find' },
            replace: { type: 'string', description: 'Replacement text' },
          },
          required: ['path', 'search', 'replace'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'bash',
        description: 'Run a shell command. Captures stdout and stderr. 120s timeout.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to run' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep',
        description: 'Search for a pattern in files using ripgrep.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: { type: 'string', description: 'Directory or file to search (default: workdir)' },
            glob: { type: 'string', description: 'Glob pattern to filter files' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'glob',
        description: 'List files matching a pattern (max 200 results).',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g. "*.ts")' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for information (Phase 2).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      },
    },
  ];
}
