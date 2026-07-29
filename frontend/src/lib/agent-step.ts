/**
 * agent_step payload helpers for the lemcore structured run view.
 * Backend shape (loop.ts):
 * { stepId, status, kind, tool?, title, detail?, outputPreview?, durationMs?, tokensUsed? }
 */
import { asRecord, firstStringField } from '@/lib/event-payload';

export type AgentStepStatus = 'running' | 'done' | 'error';
export type AgentStepKind = 'assistant' | 'tool';

export interface AgentStep {
  /** Stable id shared by start + finish events for the same step. */
  stepId: string;
  /** Latest event id (for React keys when status updates). */
  eventKey: string;
  status: AgentStepStatus;
  kind: AgentStepKind;
  tool?: string;
  title: string;
  detail?: string;
  outputPreview?: string;
  durationMs?: number;
  tokensUsed?: number;
}

const STATUSES = new Set<string>(['running', 'done', 'error']);
const KINDS = new Set<string>(['assistant', 'tool']);

export function parseAgentStep(payload: unknown, eventKey = ''): AgentStep | null {
  const record = asRecord(payload);
  if (!record) return null;
  const stepId = firstStringField(record, ['stepId'], { allowEmpty: false });
  const title = firstStringField(record, ['title'], { allowEmpty: false });
  const statusRaw = firstStringField(record, ['status'], { allowEmpty: false });
  const kindRaw = firstStringField(record, ['kind'], { allowEmpty: false });
  if (!stepId || !title || !statusRaw || !kindRaw) return null;
  if (!STATUSES.has(statusRaw) || !KINDS.has(kindRaw)) return null;

  const tool = firstStringField(record, ['tool'], { allowEmpty: false }) ?? undefined;
  const detail = firstStringField(record, ['detail']) ?? undefined;
  const outputPreview = firstStringField(record, ['outputPreview']) ?? undefined;
  const durationMs = numberField(record, 'durationMs');
  const tokensUsed = numberField(record, 'tokensUsed');

  return {
    stepId,
    eventKey: eventKey || stepId,
    status: statusRaw as AgentStepStatus,
    kind: kindRaw as AgentStepKind,
    ...(tool ? { tool } : {}),
    title,
    ...(detail ? { detail } : {}),
    ...(outputPreview ? { outputPreview } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Fold ordered events into steps; later updates with the same stepId win. */
export function reduceAgentSteps(
  events: Array<{ id: string; kind: string; payload: unknown }>,
): AgentStep[] {
  const order: string[] = [];
  const byId = new Map<string, AgentStep>();
  for (const event of events) {
    if (event.kind !== 'agent_step') continue;
    const step = parseAgentStep(event.payload, event.id);
    if (!step) continue;
    if (!byId.has(step.stepId)) order.push(step.stepId);
    byId.set(step.stepId, step);
  }
  return order.map((id) => byId.get(id)!);
}

/** Merge history steps with live updates (live wins on the same stepId). */
export function mergeAgentSteps(history: AgentStep[], live: AgentStep[]): AgentStep[] {
  if (live.length === 0) return history;
  const order: string[] = [];
  const byId = new Map<string, AgentStep>();
  for (const step of history) {
    if (!byId.has(step.stepId)) order.push(step.stepId);
    byId.set(step.stepId, step);
  }
  for (const step of live) {
    if (!byId.has(step.stepId)) order.push(step.stepId);
    byId.set(step.stepId, step);
  }
  return order.map((id) => byId.get(id)!);
}

export function toolIcon(tool?: string): string {
  switch (tool) {
    case 'read_file':
      return '📖';
    case 'write_file':
      return '✏️';
    case 'edit_file':
      return '🔧';
    case 'bash':
      return '💻';
    case 'grep':
    case 'glob':
      return '🔍';
    case 'web_search':
      return '🌐';
    default:
      return tool ? '🛠️' : '💬';
  }
}

export function formatDurationMs(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

export function formatTokens(n: number | undefined): string | null {
  if (n === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n < 1000) return `${Math.round(n)}`;
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** Sticky-header status line from the latest step. */
export function headerStatusText(steps: AgentStep[], running: boolean): string {
  if (steps.length === 0) return running ? 'Starting…' : 'Idle';
  const last = steps[steps.length - 1]!;
  if (last.status === 'running') {
    if (last.kind === 'tool') return `Running ${last.tool ?? last.title}`;
    return 'Thinking';
  }
  if (last.status === 'error') return 'Error';
  if (running) return 'Thinking';
  return 'Done';
}

export function totalTokensUsed(steps: AgentStep[]): number {
  return steps.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);
}
