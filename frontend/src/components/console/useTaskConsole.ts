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

function createEventDispatcher(
  logCounter: React.MutableRefObject<number>,
  setLiveLogs: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setLiveSteps: React.Dispatch<React.SetStateAction<AgentStep[]>>,
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
  setLiveStatus: (status: string | null) => void,
) {
  const queryClient = useQueryClient();
  const [liveLogs, setLiveLogs] = React.useState<LogLine[]>([]);
  const [liveSteps, setLiveSteps] = React.useState<AgentStep[]>([]);
  const [streamError, setStreamError] = React.useState(false);
  const logCounter = React.useRef(0);

  React.useEffect(() => {
    if (!taskId) return;
    const onStatus = (status: string) => {
      setLiveStatus(status);
      applyTaskStatusToCaches(queryClient, taskId, status);
    };
    const dispatch = createEventDispatcher(logCounter, setLiveLogs, setLiveSteps, onStatus);
    const source = openEventStream(taskId, seenEventIds, dispatch, setStreamError);
    return () => source.close();
  }, [taskId, seenEventIds, setLiveStatus, queryClient]);

  return { liveLogs, liveSteps, streamError, setLiveLogs, setLiveSteps, setStreamError };
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
    stream.setStreamError(false);
  }, [taskId]);

  const agentSteps = React.useMemo(
    () => mergeAgentSteps(historySteps, stream.liveSteps),
    [historySteps, stream.liveSteps],
  );

  return {
    historyQuery,
    historyLogs,
    historyStatus,
    liveLogs: stream.liveLogs,
    streamError: stream.streamError,
    agentSteps,
    hasAgentSteps: agentSteps.length > 0,
  };
}
