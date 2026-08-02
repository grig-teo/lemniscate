// Loop detection for lemcore tool calls. Keyed by workdir (like the TODO
// store) so concurrent runs don't share state. Counts IDENTICAL read-only
// exploration calls (same tool + same args) — the classic token-burn pattern
// (41× the same grep, 14× the same file read). Mutating tools and bash are
// excluded: repeated tests/edits are legitimate fix-verify cycles.
//
// Policy: at NUDGE_AT identical calls the tool still runs but its result
// carries a warning; at BLOCK_AT the call is NOT executed and the model gets
// a corrective error instead. The run itself is never aborted — the model
// reroutes (matches the no-hard-limits rule for tool failures).
export const LOOP_NUDGE_AT = 3;
export const LOOP_BLOCK_AT = 5;

const TRACKED_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'list_dir',
  'web_search',
  'graph_query',
  'graph_impact',
  'graph_neighbors',
  'graph_search',
]);

export interface LoopCheck {
  blocked: boolean;
  /** Warning appended to the tool result (nudge) or used as the error (block). */
  note?: string;
}

const counters = new Map<string, Map<string, number>>();

export function resetLoopDetection(workdir: string): void {
  counters.delete(workdir);
}

export function checkToolCallLoop(
  workdir: string,
  name: string,
  args: Record<string, unknown>,
): LoopCheck {
  if (!TRACKED_TOOLS.has(name)) return { blocked: false };
  const signature = `${name}:${JSON.stringify(args).slice(0, 200)}`;
  let perWorkdir = counters.get(workdir);
  if (!perWorkdir) {
    perWorkdir = new Map();
    counters.set(workdir, perWorkdir);
  }
  const count = (perWorkdir.get(signature) ?? 0) + 1;
  perWorkdir.set(signature, count);
  if (count >= LOOP_BLOCK_AT) {
    return {
      blocked: true,
      note:
        `loop-detection: this exact ${name} call was already made ${count} times with the ` +
        'same result — it is now blocked. Decide with the data you already have and move forward.',
    };
  }
  if (count >= LOOP_NUDGE_AT) {
    return {
      blocked: false,
      note:
        `\n[loop-detection: this exact ${name} call was already made ${count} times with the ` +
        'same result — stop re-exploring and act on what you have]',
    };
  }
  return { blocked: false };
}
