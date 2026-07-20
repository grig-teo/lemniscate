/**
 * Data layer for the agent console: task-event history (REST) plus the live
 * SSE stream, with replayed-history dedupe shared between the two.
 */
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { API_BASE_URL, type TaskEventItem } from '@/lib/hooks';
import { api } from '@/lib/api';
import { payloadToLogText, statusFromPayload } from '@/lib/event-payload';
import { useWorkspaceSelection } from '@/lib/selection';

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

// History ids seed the dedupe set so SSE-replayed history is skipped.
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

/** Route one stream event to the log list or the status badge. */
function createEventDispatcher(
  logCounter: React.MutableRefObject<number>,
  setLiveLogs: React.Dispatch<React.SetStateAction<LogLine[]>>,
  setLiveStatus: (status: string | null) => void,
) {
  return (event: StreamEvent) => {
    if (event.kind === 'status') {
      const status = statusFromPayload(event.payload);
      if (status) setLiveStatus(status);
      return;
    }
    if (event.kind !== 'log') return;
    logCounter.current += 1;
    const line: LogLine = {
      key: event.id ?? `live-${logCounter.current}`,
      text: payloadToLogText(event.payload),
    };
    setLiveLogs((prev) => [...prev, line]);
  };
}

/** Open the SSE stream; replayed history events (seen ids) are skipped. */
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

/** Live SSE stream for one task — closed on task switch / unmount. */
function useTaskEventStream(
  taskId: string | null,
  seenEventIds: SeenEventIds,
  setLiveStatus: (status: string | null) => void,
) {
  const [liveLogs, setLiveLogs] = React.useState<LogLine[]>([]);
  const [streamError, setStreamError] = React.useState(false);
  const logCounter = React.useRef(0);

  React.useEffect(() => {
    if (!taskId) return;
    const dispatch = createEventDispatcher(logCounter, setLiveLogs, setLiveStatus);
    const source = openEventStream(taskId, seenEventIds, dispatch, setStreamError);
    return () => source.close();
  }, [taskId, seenEventIds, setLiveStatus]);

  return { liveLogs, streamError, setLiveLogs, setStreamError };
}

/** Last status seen in history — live SSE status overrides it. */
function lastHistoryStatus(events: TaskEventItem[] | undefined): string | null {
  const list = events ?? [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].kind !== 'status') continue;
    const status = statusFromPayload(list[i].payload);
    if (status) return status;
  }
  return null;
}

/**
 * Everything the console needs for the selected task: history query and
 * derived log lines/status, plus the live stream state.
 */
export function useTaskConsole(taskId: string | null) {
  const { setLiveStatus } = useWorkspaceSelection();
  const historyQuery = useTaskEventsQuery(taskId);
  const seenEventIds = React.useRef<Set<string>>(new Set());

  useHistoryIngest(historyQuery.data, seenEventIds);
  const stream = useTaskEventStream(taskId, seenEventIds, setLiveStatus);

  // Reset per-task stream state.
  React.useEffect(() => {
    stream.setLiveLogs([]);
    stream.setStreamError(false);
  }, [taskId]);

  const historyLogs = React.useMemo<LogLine[]>(
    () =>
      (historyQuery.data ?? [])
        .filter((event) => event.kind === 'log')
        .map((event) => ({ key: event.id, text: payloadToLogText(event.payload) })),
    [historyQuery.data],
  );
  const historyStatus = React.useMemo(() => lastHistoryStatus(historyQuery.data), [historyQuery.data]);

  return {
    historyQuery,
    historyLogs,
    historyStatus,
    liveLogs: stream.liveLogs,
    streamError: stream.streamError,
  };
}
