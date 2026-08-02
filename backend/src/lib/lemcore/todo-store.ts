// Module-level TODO list store for the lemcore agent.
// The list is keyed by workdir so concurrent runs don't share state. It is
// never written into the transcript (survives compaction); loop.ts re-injects
// it into the user message every turn.
//
// The parsed item list is also surfaced to the frontend via the tool result's
// `detail` field (consumed by the ObjectiveTodoPanel in the console).
import { redactSecrets } from '../utils.js';
import { truncate, type ToolResult } from './tools.js';

const todoStore = new Map<string, string>();

export function getTodoList(workdir: string): string {
  return todoStore.get(workdir) ?? '';
}

export function setTodoList(workdir: string, list: string): void {
  todoStore.set(workdir, list);
}

export function resetTodoList(workdir: string): void {
  todoStore.delete(workdir);
}

export interface TodoItem {
  done: boolean;
  text: string;
}

/**
 * Parse a free-form TODO list (markdown checkboxes or plain lines) into
 * structured items for the frontend panel. Tolerant: accepts `- [x]`, `* [ ]`,
 * and bare lines. Blank lines are skipped.
 */
export function parseTodoItems(raw: string): TodoItem[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const checked = line.match(/^[-*]\s*\[[xX]\]\s*(.+)$/);
      if (checked) return { done: true, text: checked[1]!.trim() };
      const unchecked = line.match(/^[-*]\s*\[\s*\]\s*(.+)$/);
      if (unchecked) return { done: false, text: unchecked[1]!.trim() };
      // Strip a leading bullet if present, keep the text as a pending item.
      const bullet = line.match(/^[-*]\s*(.+)$/);
      return { done: false, text: (bullet ? bullet[1]! : line).trim() };
    })
    .filter((item) => item.text.length > 0);
}

/** Unchecked TODO items for a workdir (texts only) — the todo gate reads these. */
export function openTodoItems(workdir: string): string[] {
  return parseTodoItems(getTodoList(workdir))
    .filter((item) => !item.done)
    .map((item) => item.text);
}

export function toolTodoWrite(
  workdir: string,
  content: string,
  secrets: string[] = [],
): ToolResult {
  setTodoList(workdir, content);
  const items = parseTodoItems(content);
  return {
    tool: 'todo_write' as ToolResult['tool'],
    title: 'todo',
    durationMs: 0,
    // The parsed items let the frontend render a live checklist without
    // re-parsing the raw markdown. Redaction keeps secrets out of the panel.
    detail: JSON.stringify(items.map((i) => ({ done: i.done, text: redactSecrets(i.text, secrets) }))),
    outputPreview: truncate(
      redactSecrets(
        `TODO list updated (${items.length} items)`,
        secrets,
      ),
    ),
  };
}
