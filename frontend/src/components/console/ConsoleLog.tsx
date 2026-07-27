import { ArrowDown } from 'lucide-react';

import type { LogLine } from '@/components/console/useTaskConsole';
import { useFollowLatest } from '@/lib/use-follow-latest';

interface HistoryQuery {
  isLoading: boolean;
  isError: boolean;
  error: { message: string } | null;
}

function LogLinePre({ line }: { line: LogLine }) {
  return <pre className="whitespace-pre-wrap break-words">{line.text}</pre>;
}

function JumpToLatestButton({
  unreadCount,
  onClick,
}: {
  unreadCount: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Jump to latest logs"
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 font-sans text-xs font-medium text-zinc-700 shadow-lg backdrop-blur transition hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      Latest logs
      {unreadCount > 0 && (
        <span className="rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-300">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

function ConsoleStatus({
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
  return (
    <>
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
        <p className="mt-2 text-yellow-600 dark:text-yellow-400">
          — connection lost; reconnecting to the event stream…
        </p>
      )}
      {!historyQuery.isLoading && historyLogs.length === 0 && liveLogs.length === 0 && (
        <p className="text-zinc-500">Waiting for agent output…</p>
      )}
    </>
  );
}

/**
 * Scrolling log area: history first, then live-streamed lines. Auto-scrolls
 * to the bottom on new output only while the user is pinned to the latest
 * logs; scrolling up pauses follow mode and reveals a "jump to latest"
 * button that re-engages it.
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
  const follow = useFollowLatest(historyLogs.length + liveLogs.length, [
    historyLogs,
    liveLogs,
    streamError,
  ]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={follow.scrollRef}
        onScroll={follow.handleScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-white px-4 py-3 font-mono text-xs leading-5 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-200"
        aria-live="polite"
      >
        <ConsoleStatus
          historyQuery={historyQuery}
          historyLogs={historyLogs}
          liveLogs={liveLogs}
          streamError={streamError}
        />
      </div>
      {!follow.isFollowingLatest && (
        <JumpToLatestButton unreadCount={follow.unreadCount} onClick={follow.jumpToLatest} />
      )}
    </div>
  );
}
