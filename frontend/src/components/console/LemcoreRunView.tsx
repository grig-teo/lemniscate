/**
 * Lemcore structured run view: vertical step timeline instead of the raw log.
 * Shown when a task has agent_step events (lemcore executor).
 */
import * as React from 'react';
import { ArrowDown, Check, Loader2, X } from 'lucide-react';

import { MarkdownView } from '@/components/MarkdownView';
import {
  formatDurationMs,
  formatTokens,
  headerStatusText,
  toolIcon,
  totalTokensUsed,
  type AgentStep,
} from '@/lib/agent-step';
import { useFollowLatest } from '@/lib/use-follow-latest';
import { cn } from '@/lib/utils';

function StatusGlyph({ status }: { status: AgentStep['status'] }) {
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600 dark:text-sky-400" aria-label="running" />;
  }
  if (status === 'error') {
    return <X className="h-3.5 w-3.5 text-red-600 dark:text-red-400" aria-label="error" />;
  }
  return <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-label="done" />;
}

function DurationBadge({ ms }: { ms?: number }) {
  const label = formatDurationMs(ms);
  if (!label) return null;
  return (
    <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {label}
    </span>
  );
}

function ExpandableBody({ step }: { step: AgentStep }) {
  const [open, setOpen] = React.useState(step.status === 'error');
  const hasBody = Boolean(step.detail || step.outputPreview);
  if (!hasBody) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-medium text-sky-700 hover:underline dark:text-sky-400"
      >
        {open ? 'Hide details' : 'Show details'}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {step.detail && step.kind === 'assistant' && (
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900">
              <MarkdownView className="text-xs leading-relaxed">{step.detail}</MarkdownView>
            </div>
          )}
          {step.detail && step.kind === 'tool' && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] leading-4 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              {step.detail}
            </pre>
          )}
          {step.outputPreview && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] leading-4 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">
              {step.outputPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantBubble({ step }: { step: AgentStep }) {
  const body = step.detail || step.title;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        step.status === 'error'
          ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
          : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900',
      )}
      data-step-id={step.stepId}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
        <span aria-hidden>💬</span>
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{step.title}</span>
        <StatusGlyph status={step.status} />
        <DurationBadge ms={step.durationMs} />
        {formatTokens(step.tokensUsed) && (
          <span className="text-[10px] text-zinc-500">~{formatTokens(step.tokensUsed)} tok</span>
        )}
      </div>
      {step.status === 'running' && !step.detail ? (
        <p className="text-xs text-zinc-500">Thinking…</p>
      ) : (
        <MarkdownView className="text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
          {body}
        </MarkdownView>
      )}
    </div>
  );
}

function ToolCard({ step }: { step: AgentStep }) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2',
        step.status === 'error'
          ? 'border-red-200 bg-red-50/80 dark:border-red-900 dark:bg-red-950/30'
          : 'border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900/80',
      )}
      data-step-id={step.stepId}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-base leading-none" aria-hidden>
          {toolIcon(step.tool)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {step.title}
            </span>
            <StatusGlyph status={step.status} />
            <DurationBadge ms={step.durationMs} />
          </div>
          {step.tool && (
            <p className="mt-0.5 text-[11px] text-zinc-500">{step.tool}</p>
          )}
          <ExpandableBody step={step} />
        </div>
      </div>
    </div>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  if (step.kind === 'assistant') return <AssistantBubble step={step} />;
  return <ToolCard step={step} />;
}

function StickyHeader({
  steps,
  running,
  elapsedLabel,
}: {
  steps: AgentStep[];
  running: boolean;
  elapsedLabel: string | null;
}) {
  const tokens = totalTokensUsed(steps);
  const tokenLabel = formatTokens(tokens);
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-white/95 px-4 py-2 text-xs backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
      <span className="font-semibold text-zinc-800 dark:text-zinc-100">
        {headerStatusText(steps, running)}
      </span>
      {elapsedLabel && <span className="text-zinc-500">⏱ {elapsedLabel}</span>}
      {tokenLabel && <span className="text-zinc-500">~{tokenLabel} tokens</span>}
      <span className="text-zinc-400">{steps.length} step{steps.length === 1 ? '' : 's'}</span>
    </div>
  );
}

function JumpButton({ unreadCount, onClick }: { unreadCount: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Jump to latest steps"
      className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-lg backdrop-blur transition hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-900/95 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
      Latest
      {unreadCount > 0 && (
        <span className="rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-700 dark:bg-sky-900 dark:text-sky-300">
          {unreadCount}
        </span>
      )}
    </button>
  );
}

function useElapsedLabel(running: boolean, anchorMs: number | null): string | null {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running || anchorMs === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, anchorMs]);
  if (anchorMs === null) return null;
  return formatDurationMs(Math.max(0, now - anchorMs));
}

export function LemcoreRunView({
  steps,
  running,
  streamError,
  isLoading,
  isError,
  errorMessage,
  startedAtMs = null,
}: {
  steps: AgentStep[];
  running: boolean;
  streamError: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string | null;
  /** Wall-clock start for elapsed header; null hides the timer. */
  startedAtMs?: number | null;
}) {
  const follow = useFollowLatest(steps.length, [steps, streamError, running]);
  const elapsedLabel = useElapsedLabel(running, startedAtMs);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <StickyHeader steps={steps} running={running} elapsedLabel={elapsedLabel} />
      <div
        ref={follow.scrollRef}
        onScroll={follow.handleScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-zinc-50 px-4 py-3 dark:bg-zinc-950"
        aria-live="polite"
        data-testid="lemcore-run-view"
      >
        {isLoading && <p className="text-xs text-zinc-500">Loading run…</p>}
        {isError && (
          <p className="text-xs text-red-600 dark:text-red-400">
            Failed to load history{errorMessage ? `: ${errorMessage}` : ''}
          </p>
        )}
        {!isLoading && steps.length === 0 && (
          <p className="text-xs text-zinc-500">
            {running ? 'Waiting for lemcore agent steps…' : 'No agent steps yet.'}
          </p>
        )}
        {steps.map((step) => (
          <StepRow key={step.eventKey + step.status} step={step} />
        ))}
        {streamError && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            — connection lost; reconnecting…
          </p>
        )}
      </div>
      {!follow.isFollowingLatest && (
        <JumpButton unreadCount={follow.unreadCount} onClick={follow.jumpToLatest} />
      )}
    </div>
  );
}
