// Multi-sample edit verification: when the model's first edit attempt fails
// lint, make ONE additional LLM call (different seed + nudge) and try the
// alternative. The common path (first attempt is lint-clean) costs zero extra
// — the fallback only fires on lint failure (SWE-bench pass@2 >> pass@1).
import type { ChatToolCall } from '../llm-client.js';
import { chatCompletion } from '../llm-dispatch.js';
import { resolveLlmAccessToken } from '../llm-access-token.js';
import { config } from '../../config.js';
import { logEvent } from '../agent-git.js';
import { lintAndMaybeRevert, checkpointEdit } from './edit-checkpoint.js';
import { jailPath, truncate, type ToolResult, type ToolName } from './tools.js';
import { redactSecrets } from '../utils.js';
import type { LlmRuntime } from '../agent-runtime.js';
import { promises as fs } from 'node:fs';

interface MultiSampleOpts {
  workdir: string;
  rt: LlmRuntime;
  taskId: string;
  toolCall: ChatToolCall;
  /** File being edited, already validated by the caller (edit-router). */
  relPath: string;
  originalContent: string;
  primaryNewContent: string;
  secrets: string[];
}

export async function verifyEditWithFallback(opts: MultiSampleOpts): Promise<ToolResult> {
  const { workdir, rt, taskId, toolCall, relPath, originalContent, primaryNewContent, secrets } = opts;

  const primary = await lintAndMaybeRevert(
    workdir, relPath, originalContent, primaryNewContent, secrets, Date.now(),
    toolCall.function.name as ToolName,
  );
  if (!primary.error) return primary;

  if (!config.LEMCORE_MULTI_SAMPLE || !relPath) return primary;

  const fallback = await tryFallbackEdit(opts, primary.error);
  if (fallback) {
    await logEvent(taskId, `multi-sample: fallback edit accepted for ${relPath}`);
    return fallback;
  }
  return primary;
}

async function tryFallbackEdit(
  opts: MultiSampleOpts,
  primaryError: string,
): Promise<ToolResult | null> {
  const { workdir, rt, toolCall, relPath, originalContent, secrets } = opts;
  if (!relPath) return null;

  try {
    const apiKey = await resolveLlmAccessToken(rt.cfg);
    const result = await chatCompletion({
      baseUrl: rt.cfg.baseUrl,
      apiKey,
      model: rt.cfg.model,
      apiPattern: rt.cfg.apiPattern,
      messages: [{
        role: 'user',
        content: `Your previous edit to "${relPath}" introduced lint errors:\n${primaryError.slice(0, 800)}\n\nTry a DIFFERENT approach. Call ${toolCall.function.name} again with corrected content.`,
      }],
      temperature: 0.4,
      maxTokens: 4096,
      seed: Date.now() % 2147483647,
      timeoutSeconds: rt.cfg.timeoutSeconds,
      maxRetries: 1,
      customHeaders: {},
    });

    const fallbackArgs = extractToolArgs(result.content);
    if (!fallbackArgs) return null;

    const fallbackContent = computeEditContent(
      originalContent, fallbackArgs, toolCall.function.name,
    );
    if (!fallbackContent) return null;

    await fs.writeFile(jailPath(workdir, relPath), originalContent, 'utf8');
    checkpointEdit(workdir, relPath, originalContent);

    return await lintAndMaybeRevert(
      workdir, relPath, originalContent, fallbackContent, secrets,
      Date.now(), toolCall.function.name as ToolName,
    );
  } catch {
    return null;
  }
}

/**
 * Extract the first balanced JSON object containing "path" from the model's
 * free-text response. Uses brace-depth tracking (not a regex) because the old
 * regex stopped at the first `}` — which is frequently inside a string value
 * or a nested array/object (multi_edit edits, write_file content with braces),
 * silently disabling the fallback for the most common edit shapes.
 */
export function extractToolArgs(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = content.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && 'path' in parsed) return parsed;
        } catch { /* not valid JSON — keep scanning */ }
        // Not a valid path-bearing object — continue from the next `{`.
        return extractToolArgs(content.slice(i + 1));
      }
    }
  }
  return null;
}

function computeEditContent(
  original: string, args: Record<string, unknown>, toolName: string,
): string | null {
  if (toolName === 'edit_file') {
    const search = String(args.search ?? '');
    const replace = String(args.replace ?? '');
    if (!search || !original.includes(search)) return null;
    return original.replace(search, () => replace);
  }
  if (toolName === 'multi_edit' && Array.isArray(args.edits)) {
    let content = original;
    for (const edit of args.edits as Record<string, unknown>[]) {
      const s = String(edit.search ?? '');
      const r = String(edit.replace ?? '');
      if (!s || !content.includes(s)) return null;
      content = content.replace(s, () => r);
    }
    return content;
  }
  if (toolName === 'write_file') return String(args.content ?? '');
  return null;
}
