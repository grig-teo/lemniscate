import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { useUsage, type UsagePeriod } from '@/lib/hooks';
import { formatCostUsd, formatTokens } from '@/lib/token-usage';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

/**
 * Settings → Usage: LLM token consumption (and estimated spend when LLM
 * configs carry prices) over the last 7 or 30 days, totaled, per repository,
 * and per day. Backed by GET /api/usage.
 */
export function UsageSection() {
  const [period, setPeriod] = React.useState<UsagePeriod>('30d');
  const usage = useUsage(period);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">LLM usage</h3>
        <PeriodToggle period={period} onChange={setPeriod} />
      </div>
      {usage.isLoading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Loading usage…
        </p>
      )}
      {usage.isError && <p className="text-xs text-destructive">Failed to load usage.</p>}
      {usage.data && <UsageReportView report={usage.data} />}
    </section>
  );
}

function PeriodToggle({
  period,
  onChange,
}: {
  period: UsagePeriod;
  onChange: (period: UsagePeriod) => void;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label="Usage period">
      {(['7d', '30d'] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={period === value}
          className={cn(
            'rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground',
            period === value && 'border-primary bg-primary/10 text-foreground',
          )}
        >
          {value === '7d' ? '7 days' : '30 days'}
        </button>
      ))}
    </div>
  );
}

function UsageReportView({ report }: { report: ReturnType<typeof useUsage>['data'] }) {
  if (!report) return null;
  if (report.totals.totalTokens === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No LLM tokens used in this period.
      </p>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {formatTokens(report.totals.totalTokens)} tokens
        </Badge>
        {report.totals.estimatedCostUsd != null && (
          <Badge variant="outline" className="font-mono">
            est. {formatCostUsd(report.totals.estimatedCostUsd)}
          </Badge>
        )}
        <span className="text-[11px] text-muted-foreground">
          {formatTokens(report.totals.promptTokens)} prompt · {formatTokens(report.totals.completionTokens)} completion
        </span>
      </div>
      <UsageTable
        title="Per repository"
        rows={report.byRepository.map((bucket) => ({
          key: bucket.repositoryId,
          label: bucket.fullName,
          bucket,
        }))}
      />
      <UsageTable
        title="Per day"
        rows={report.byDay.map((bucket) => ({ key: bucket.day, label: bucket.day, bucket }))}
      />
      <p className="text-[11px] leading-snug text-muted-foreground/80">{report.semantics}</p>
    </>
  );
}

function UsageTable({
  title,
  rows,
}: {
  title: string;
  rows: { key: string; label: string; bucket: { totalTokens: number; estimatedCostUsd?: number } }[];
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {title}
      </h4>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span className="font-mono text-muted-foreground">{formatTokens(row.bucket.totalTokens)}</span>
            {row.bucket.estimatedCostUsd != null && (
              <span className="font-mono text-muted-foreground">
                est. {formatCostUsd(row.bucket.estimatedCostUsd)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
