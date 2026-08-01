// Module-level TODO list store for the lemcore agent.
// The list is never written into the transcript, so it survives compaction;
// loop.ts re-injects it into the system message every turn.
import { redactSecrets } from '../utils.js';
import { truncate, type ToolResult } from './tools.js';

let todoList = '';

export function getTodoList(): string {
  return todoList;
}

export function setTodoList(list: string): void {
  todoList = list;
}

export function resetTodoList(): void {
  todoList = '';
}

export function toolTodoWrite(content: string, secrets: string[] = []): ToolResult {
  setTodoList(content);
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
