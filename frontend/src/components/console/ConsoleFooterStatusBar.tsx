import { Activity, Gauge } from 'lucide-react';

import { contextUsageLabel, contextUsageLevel, quotaLines } from '@/lib/console-footer';
import { useLlmConfigQuota, type Task } from '@/lib/hooks';
import { cn } from '@/lib/utils';

import { ModelSwitchDropdown } from '@/components/console/ModelSwitchDropdown';

/** Quota snapshots only change on LLM responses — 15s is plenty. */
const QUOTA_POLL_INTERVAL_MS = 15_000;

const LEVEL_TEXT_STYLES = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  critical: 'text-red-600 dark:text-red-400',
} as const;

const LEVEL_BAR_STYLES = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
} as const;

/**
 * Session context indicator: tokens burned by this task vs the active
 * model's context window, escalating green → amber (≥60%) → red (>85%).
 * Renders nothing when the effective config's window is unknown.
 */
function ContextIndicator({ task }: { task: Task }) {
  const used = task.llmTokensUsed;
  const window = task.contextWindow ?? null;
  if (!window) return null;
  const level = contextUsageLevel(used, window);
  const percent = Math.min(100, Math.round((used / window) * 100));
  return (
    <span
      className={cn('flex items-center gap-1.5', LEVEL_TEXT_STYLES[level])}
      title={`Session context usage — ${percent}% of the model's context window`}
    >
      <Gauge className="h-3.5 w-3.5" aria-hidden />
      <span className="font-mono">{contextUsageLabel(used, window)}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full', LEVEL_BAR_STYLES[level])} style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

/**
 * Rate-limit / quota indicator: the 5-hour (short) and weekly windows parsed
 * from the provider's response headers (backend llm-quota.ts). Providers
 * that expose nothing render "limits n/a" — the UI never blocks on it.
 */
function QuotaIndicator({ configId }: { configId: string | null }) {
  const quota = useLlmConfigQuota(configId, { refetchInterval: QUOTA_POLL_INTERVAL_MS });
  const lines = quotaLines(quota.data);
  const title = quota.data
    ? `Provider rate limits — captured ${new Date(quota.data.capturedAt).toLocaleTimeString()}`
    : 'This provider exposes no rate-limit data (or none recorded yet)';
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground" title={title}>
      <Activity className="h-3.5 w-3.5" aria-hidden />
      <span>{lines.length > 0 ? lines.join(' · ') : 'limits n/a'}</span>
    </span>
  );
}

/**
 * Status footer bar at the bottom of the agent console, mounted while a task
 * is queued/running/reviewing code. Three elements: the session context
 * indicator, the active-model dropdown (mid-run switching), and the provider
 * rate-limit indicator. Data comes from the polled task row (usage payload
 * fields) and GET /api/llm-configs/:id/quota.
 */
export function ConsoleFooterStatusBar({ task }: { task: Task }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5 text-xs"
      data-testid="console-footer-status-bar"
    >
      <ContextIndicator task={task} />
      <ModelSwitchDropdown task={task} />
      <QuotaIndicator configId={task.effectiveLlmConfigId ?? null} />
    </div>
  );
}
