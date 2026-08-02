// Bridge between executeTool and the edit tools: when a runtime context is
// available, edit_file / multi_edit route through verifyEditWithFallback
// (lint-gate + multi-sample fallback) instead of the plain lint-gate. Keeps
// the validation logic in one place (prepareEditContent) so both paths agree.
import type { ChatToolCall } from '../llm-client.js';
import type { LlmRuntime } from '../agent-runtime.js';
import { prepareEditContent, type ToolResult } from './tools.js';
import { lintAndMaybeRevert } from './edit-checkpoint.js';
import { verifyEditWithFallback } from './multi-sample.js';

export interface EditCtx {
  rt: LlmRuntime;
  taskId: string;
  toolCall: ChatToolCall;
}

/**
 * Prepare the edit content (validate + checkpoint), then either:
 *  - with a runtime context: verifyEditWithFallback (lint + multi-sample), or
 *  - without: the plain lint-gate (lintAndMaybeRevert).
 * The `compute` callback owns the search/replace validation and new-content
 * derivation, shared with the no-context path so the two cannot diverge.
 */
export async function runEdit(
  toolName: 'edit_file' | 'multi_edit',
  relPath: string,
  workdir: string,
  secrets: string[],
  ctx: EditCtx | undefined,
  compute: (original: string) => string,
): Promise<ToolResult> {
  const startMs = Date.now();
  const { originalContent, newContent } = await prepareEditContent(workdir, relPath, compute);
  if (ctx) {
    return verifyEditWithFallback({
      workdir, rt: ctx.rt, taskId: ctx.taskId, toolCall: ctx.toolCall,
      originalContent, primaryNewContent: newContent, secrets,
    });
  }
  return lintAndMaybeRevert(workdir, relPath, originalContent, newContent, secrets, startMs, toolName);
}
