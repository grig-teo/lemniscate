/**
 * Classifier for raw agent console log lines.
 *
 * The backend streams free-form `log` events (`logEvent` in agent-git.ts);
 * this module is the single place that recognizes the well-known line
 * shapes — `$ git …` command echoes, `→ LLM call` / `← LLM done` metrics,
 * `LLM retry …`, `⇄ model switch …`, `error: …`, and `✎ path (action)`
 * diff summaries (see event-payload.ts payloadToDiffText) — so the console
 * can render them as structured UI rows instead of a raw monospace dump.
 * Anything unrecognized stays an 'info' row. Pure module — no React.
 */

export type ConsoleLogRow =
  | { kind: 'command'; text: string }
  | { kind: 'llm-start'; model: string }
  | { kind: 'llm-done'; seconds: string; tokens: number }
  | { kind: 'llm-retry'; text: string }
  | { kind: 'model-switch'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'file'; path: string; action: 'created' | 'modified' | 'deleted' }
  | { kind: 'info'; text: string };

const LLM_START_RE = /^→ LLM call \((.+)\)$/;
const LLM_DONE_RE = /^← LLM done in ([\d.]+)s, ~(\d+) tokens$/;
const LLM_RETRY_RE = /^LLM retry /;
const MODEL_SWITCH_RE = /^⇄ /;
const ERROR_RE = /^error:\s*/;
const FILE_RE = /^✎ (.+) \(([^)]+)\)$/;
const COMMAND_RE = /^\$ /;

function fileAction(raw: string): 'created' | 'modified' | 'deleted' {
  if (raw === 'created' || raw === 'deleted') return raw;
  return 'modified';
}

/** Classify one raw console log line into a structured UI row. */
export function classifyConsoleLog(text: string): ConsoleLogRow {
  const trimmed = text.trim();

  const llmStart = LLM_START_RE.exec(trimmed);
  if (llmStart) return { kind: 'llm-start', model: llmStart[1]! };

  const llmDone = LLM_DONE_RE.exec(trimmed);
  if (llmDone) {
    return { kind: 'llm-done', seconds: llmDone[1]!, tokens: Number(llmDone[2]) };
  }

  if (LLM_RETRY_RE.test(trimmed)) return { kind: 'llm-retry', text: trimmed };
  if (MODEL_SWITCH_RE.test(trimmed)) return { kind: 'model-switch', text: trimmed.slice(2) };

  if (ERROR_RE.test(trimmed)) return { kind: 'error', text: trimmed.replace(ERROR_RE, '') };

  const file = FILE_RE.exec(trimmed);
  if (file) return { kind: 'file', path: file[1]!, action: fileAction(file[2]!) };

  if (COMMAND_RE.test(trimmed)) return { kind: 'command', text: trimmed.slice(2) };

  return { kind: 'info', text };
}
