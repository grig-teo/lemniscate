import * as React from 'react';

import type { LogLine } from '@/components/console/useTaskConsole';

interface HistoryQuery {
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

function LogLinePre({ line }: { line: LogLine }) {
  return <pre className="whitespace-pre-wrap break-words">{line.text}</pre>;
}

/**
 * Scrolling log area: history first, then live-streamed lines, with
 * auto-scroll to bottom on new output.
 */
export function ConsoleLog({
  historyQuery,
  historyLogs,
  liveLogs,
  streamError,
}: {
  historyQuery: HistoryQuery;
  historyLogs: LogLine[];
  liveLogs: LogLine[];
  streamError: boolean;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [historyLogs, liveLogs, streamError]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-3 font-mono text-xs leading-5 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-200"
      aria-live="polite"
    >
      {historyQuery.isLoading && <p className="text-zinc-500">Loading task history…</p>}
      {historyQuery.isError && (
        <p className="text-red-600 dark:text-red-400">
          Failed to load task history: {historyQuery.error?.message}
        </p>
      )}
      {historyLogs.map((line) => (
        <LogLinePre key={line.key} line={line} />
      ))}
      {liveLogs.map((line) => (
        <LogLinePre key={line.key} line={line} />
      ))}
      {streamError && (
        <p className="mt-2 text-yellow-600 dark:text-yellow-400">— connection lost; reconnecting to the event stream…</p>
      )}
      {!historyQuery.isLoading && historyLogs.length === 0 && liveLogs.length === 0 && (
        <p className="text-zinc-500">Waiting for agent output…</p>
      )}
    </div>
  );
}
