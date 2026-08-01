// Module-level TODO list store for the lemcore agent.
// The list is keyed by workdir so concurrent runs don't share state. It is
// never written into the transcript (survives compaction); loop.ts re-injects
// it into the user message every turn.
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

export function toolTodoWrite(
  workdir: string,
  content: string,
  secrets: string[] = [],
): ToolResult {
  setTodoList(workdir, content);
  return {
    tool: 'todo_write' as ToolResult['tool'],
    title: 'todo',
    durationMs: 0,
    outputPreview: truncate(
      redactSecrets(
        `TODO list updated (${content.split('\n').filter((l) => l.trim()).length} items)`,
        secrets,
      ),
    ),
  };
}
