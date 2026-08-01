import type { Task, TaskStatus } from './task-types';

// The Kanban board maps the real 9 TaskStatus values into 4 columns. The data
// model is untouched (no status enum change); this is a pure presentation
// mapping. Each column's `statuses` set is the source of truth for which tasks
// land where, and for the drag-target validation in useTaskDrop.
export interface ColumnDef {
  id: 'backlog' | 'processes' | 'review' | 'done';
  title: string;
  statuses: TaskStatus[];
}

export const COLUMN_DEFS: ColumnDef[] = [
  { id: 'backlog', title: 'Prompts / Proposals', statuses: ['pending'] },
  {
    id: 'processes',
    title: 'Processes',
    statuses: ['queued', 'running', 'awaiting_plan_approval'],
  },
  {
    id: 'review',
    title: 'Code Review',
    statuses: ['awaiting_review', 'reviewing_code'],
  },
  { id: 'done', title: 'Done', statuses: ['done', 'failed', 'closed'] },
];

export interface BoardColumn {
  id: ColumnDef['id'];
  title: string;
  tasks: Task[];
}

/** Splits a flat task list into the 4 board columns, in canonical order. */
export function boardColumns(tasks: Task[]): BoardColumn[] {
  return COLUMN_DEFS.map((def) => ({
    id: def.id,
    title: def.title,
    tasks: tasks.filter((t) => (def.statuses as readonly string[]).includes(t.status)),
  }));
}

/** Terminal statuses folded into the Done column (rendered muted on cards). */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['failed', 'closed']);

/** Which column id a given status maps to (null if unknown). */
export function columnForStatus(status: TaskStatus): ColumnDef['id'] | null {
  for (const def of COLUMN_DEFS) {
    if ((def.statuses as readonly string[]).includes(status)) return def.id;
  }
  return null;
}
