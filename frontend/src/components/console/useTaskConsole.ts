/**
 * Data layer for the agent console: task-event history (REST) plus the live
 * SSE stream, with replayed-history dedupe shared between the two.
 */
import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { API_BASE_URL, type TaskEventItem } from '@/lib/hooks';
import { api } from '@/lib/api';
import {
  mergeAgentSteps,
  parseAgentStep,
  reduceAgentSteps,
  type AgentStep,
} from '@/lib/agent-step';
import { payloadToDiffText, payloadToLogText, statusFromPayload, agentStepToLogText } from '@/lib/event-payload';
import { summarizeChanges } from '@/lib/session-changes';
import { useWorkspaceSelection } from '@/lib/selection';
import { applyTaskStatusToCaches } from '@/lib/task-status-cache';

export interface LogLine {
  key: string;
  text: string;
}

interface StreamEvent {
  id?: string;
  kind: string;
  payload: unknown;
  createdAt?: string;
}

type SeenEventIds = React.MutableRefObject<Set<string>>;

function useTaskEventsQuery(taskId: string | null) {
  return useQuery({
    queryKey: ['task-events', taskId],
    queryFn: () => api.get<TaskEventItem[]>(`/api/tasks/${taskId}/events`),
    enabled: taskId !== null,
  });
}

function useHistoryIngest(events: TaskEventItem[] | undefined, seenEventIds: SeenEventIds) {
  React.useEffect(() => {
    seenEventIds.current = new Set((events ?? []).map((event) => event.id));
  }, [events, seenEventIds]);
}

function parseStreamEvent(data: string): StreamEvent | null {
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    return null;
  }
}

function eventToLogText(kind: string, payload: unknown): string | null {
  if (kind === 'log') return payloadToLogText(payload);
  if (kind === 'diff') return payloadToDiffText(payload);
  if (kind === 'agent_step') return agentStepToLogText(payload);
  return null;
}

function upsertLiveStep(prev: AgentStep[], event: StreamEvent): AgentStep[] {
  const step = parseAgentStep(event.payload, event.id ?? `live-${event.kind}`);
  if (!step) return prev;
  const idx = prev.findIndex((s) => s.stepId === step.stepId);
  if (idx === -1) return [...prev, step];
  const next = [...prev];
  next[idx] = step;
  return next;
}

function toTaskEventItem(event: StreamEvent, fallbackId: string): TaskEventItem {
  return {
    id: event.id ?? fallbackId,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt ?? new Date().toISOString(),
  };
}

function createEventDispatcher(
  logCounter: React.MutableRefObject<number>,
  setLiveLogs: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setLiveSteps: React.Dispatch<React.SetStateAction<AgentStep[]>>,
  setLiveDiffs: React.Dispatch<React.SetStateAction<TaskEventItem[]>>,
  onStatus: (status: string) => void,
) {
  return (event: StreamEvent) => {
    if (event.kind === 'status') {
      const status = statusFromPayload(event.payload);
      if (status) onStatus(status);
      return;
    }
    if (event.kind === 'agent_step') {
      setLiveSteps((prev) => upsertLiveStep(prev, event));
    }
    if (event.kind === 'diff') {
      setLiveDiffs((prev) => [...prev, toTaskEventItem(event, `live-diff-${prev.length}`)]);
    }
    const text = eventToLogText(event.kind, event.payload);
    if (text === null) return;
    logCounter.current += 1;
    const line: LogLine = {
      key: event.id ?? `live-${logCounter.current}`,
      text,
    };
    setLiveLogs((prev) => [...prev, line]);
  };
}

function openEventStream(
  taskId: string,
  seenEventIds: SeenEventIds,
  dispatch: (event: StreamEvent) => void,
  setStreamError: React.Dispatch<React.SetStateAction<boolean>>,
): EventSource {
  const source = new EventSource(`${API_BASE_URL}/api/tasks/${taskId}/events`, {
    withCredentials: true,
  });
  source.onopen = () => setStreamError(false);
  source.onmessage = (message) => {
    const event = parseStreamEvent(message.data);
    if (!event) return;
    if (event.id && seenEventIds.current.has(event.id)) return;
    if (event.id) seenEventIds.current.add(event.id);
    dispatch(event);
  };
  source.onerror = () => setStreamError(true);
  return source;
}

function useTaskEventStream(
  taskId: string | null,
  seenEventIds: SeenEventIds,
  setLiveStatus: (status: string | null, taskId?: string) => void,
) {
  const queryClient = useQueryClient();
  const [liveLogs, setLiveLogs] = React.useState<LogLine[]>([]);
  const [liveSteps, setLiveSteps] = React.useState<AgentStep[]>([]);
  const [liveDiffs, setLiveDiffs] = React.useState<TaskEventItem[]>([]);
  const [streamError, setStreamError] = React.useState(false);
  const logCounter = React.useRef(0);

  React.useEffect(() => {
    if (!taskId) return;
    const onStatus = (status: string) => {
      // Tag the status with its task so a late event from a previously
      // selected task cannot leak into the new selection's view.
      setLiveStatus(status, taskId);
      applyTaskStatusToCaches(queryClient, taskId, status);
    };
    const dispatch = createEventDispatcher(logCounter, setLiveLogs, setLiveSteps, setLiveDiffs, onStatus);
    const source = openEventStream(taskId, seenEventIds, dispatch, setStreamError);
    return () => source.close();
  }, [taskId, seenEventIds, setLiveStatus, queryClient]);

  return { liveLogs, liveSteps, liveDiffs, streamError, setLiveLogs, setLiveSteps, setLiveDiffs, setStreamError };
}

function lastHistoryStatus(events: TaskEventItem[] | undefined): string | null {
  const list = events ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].kind !== 'status') continue;
    const status = statusFromPayload(list[i].payload);
    if (status) return status;
  }
  return null;
}

export function useTaskEventHistory(taskId: string | null) {
  const historyQuery = useTaskEventsQuery(taskId);
  const historyLogs = React.useMemo<LogLine[]>(
    () =>
      (historyQuery.data ?? []).flatMap((event) => {
        const text = eventToLogText(event.kind, event.payload);
        return text === null ? [] : [{ key: event.id, text }];
      }),
    [historyQuery.data],
  );
  const historySteps = React.useMemo(
    () => reduceAgentSteps(historyQuery.data ?? []),
    [historyQuery.data],
  );
  const historyStatus = React.useMemo(() => lastHistoryStatus(historyQuery.data), [historyQuery.data]);
  return { historyQuery, historyLogs, historySteps, historyStatus };
}

export function useTaskConsole(taskId: string | null) {
  const { setLiveStatus } = useWorkspaceSelection();
  const { historyQuery, historyLogs, historySteps, historyStatus } = useTaskEventHistory(taskId);
  const seenEventIds = React.useRef<Set<string>>(new Set());

  useHistoryIngest(historyQuery.data, seenEventIds);
  const stream = useTaskEventStream(taskId, seenEventIds, setLiveStatus);

  React.useEffect(() => {
    stream.setLiveLogs([]);
    stream.setLiveSteps([]);
    stream.setLiveDiffs([]);
    stream.setStreamError(false);
  }, [taskId]);

  const agentSteps = React.useMemo(
    () => mergeAgentSteps(historySteps, stream.liveSteps),
    [historySteps, stream.liveSteps],
  );

  // Derive the Objective + TODO checklist from the step stream. The backend
  // emits agent_step events with subtype:'objective' (when the model restates
  // its goal) and subtype:'todo' (on every todo_write call, with the parsed
  // items in `detail`). The panel shows the latest of each.
  const objective = React.useMemo(() => extractLatestDetail(agentSteps, 'objective'), [agentSteps]);
  const todoItems = React.useMemo(() => parseLatestTodoItems(agentSteps), [agentSteps]);

  // Session file changes (one row per touched file, +/− totals) for the
  // header's changes badge and the changes dialog. History comes from the
  // events query; diff events arriving over the live stream are folded in so
  // the badge updates while the agent is still running (the history query
  // itself does not refetch on stream events).
  const changes = React.useMemo(
    () => summarizeChanges([...(historyQuery.data ?? []), ...stream.liveDiffs]),
    [historyQuery.data, stream.liveDiffs],
  );

  return {
    historyQuery,
    historyLogs,
    historyStatus,
    liveLogs: stream.liveLogs,
    streamError: stream.streamError,
    agentSteps,
    hasAgentSteps: agentSteps.length > 0,
    changes,
    objective,
    todoItems,
  };
}

// Latest `detail` from an agent_step with the given subtype (the Objective).
function extractLatestDetail(steps: AgentStep[], subtype: string): string | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.subtype === subtype && steps[i]!.detail) return steps[i]!.detail ?? null;
  }
  return null;
}

// Latest todo_write step's parsed items (detail is JSON: [{done, text}]).
function parseLatestTodoItems(steps: AgentStep[]): { done: boolean; text: string }[] {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.subtype === 'todo' && step.detail) {
      try {
        const parsed = JSON.parse(step.detail);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((it): it is { done: boolean; text: string } =>
              it != null && typeof it === 'object' && typeof (it as { text?: unknown }).text === 'string',
            )
            .map((it) => ({ done: Boolean(it.done), text: it.text }));
        }
      } catch {
        // malformed detail — fall through to return []
      }
      return [];
    }
  }
  return [];
}
