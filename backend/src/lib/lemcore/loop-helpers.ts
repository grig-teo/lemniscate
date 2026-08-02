// Transcript, review-file, and step-event helpers for the lemcore agent loop.
// Split out of loop.ts to stay under the per-file line limit.
import fs from 'node:fs';
import path from 'node:path';
import { publishTaskEvent } from '../task-events.js';
import { TRANSCRIPT_FILE, REVIEW_FILENAME, transcriptPath } from './loop-constants.js';
import type { LemcoreMessage, LemcoreStep } from './loop-types.js';

let stepCounter = 0;
export function nextStepId(): string {
  return `step-${++stepCounter}`;
}

// Cap the diff inside the published agent_step event: the row goes to DB +
// SSE + every connected console, so multi-MB diffs must announce instead.
export const STEP_DIFF_MAX_CHARS = 2_000;

function capStepDiff(diff: string | undefined): string | undefined {
  if (!diff) return undefined;
  if (diff.length <= STEP_DIFF_MAX_CHARS) return diff;
  return `${diff.slice(0, STEP_DIFF_MAX_CHARS)}\n… [diff truncated]`;
}

export async function publishStepEvent(taskId: string, step: LemcoreStep): Promise<void> {
  await publishTaskEvent(taskId, 'agent_step', {
    stepId: step.stepId,
    status: step.status,
    kind: step.kind,
    tool: step.tool,
    subtype: step.subtype,
    title: step.title,
    detail: step.detail,
    outputPreview: step.outputPreview ? step.outputPreview.slice(0, 2_000) : undefined,
    diff: capStepDiff(step.diff),
    durationMs: step.durationMs,
    tokensUsed: step.tokensUsed,
  });
}

/** Drop a legacy in-clone transcript left by older builds so it cannot be committed. */
export function scrubLegacyInCloneTranscript(workdir: string): void {
  const legacy = path.join(workdir, TRANSCRIPT_FILE);
  try {
    fs.unlinkSync(legacy);
  } catch {
    // absent is fine
  }
}

export function loadTranscript(workdir: string): LemcoreMessage[] | null {
  const file = transcriptPath(workdir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LemcoreMessage[];
  } catch {
    // no transcript or malformed
  }
  return null;
}

export function saveTranscript(workdir: string, messages: LemcoreMessage[]): void {
  // The transcript is bookkeeping, not critical to the run: a disk-full or FS
  // error here should never abort an otherwise-healthy turn. Log and swallow.
  try {
    const file = transcriptPath(workdir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(messages, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(
      `[lemcore] saveTranscript failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function checkReviewFile(workdir: string): Promise<boolean> {
  const file = path.join(workdir, REVIEW_FILENAME);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { verdict?: unknown };
    return typeof parsed.verdict === 'string';
  } catch {
    return false;
  }
}
