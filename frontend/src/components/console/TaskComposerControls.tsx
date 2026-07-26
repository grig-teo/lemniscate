/**
 * TaskComposer toolbar controls: the repository/model/thinking-level selects
 * and the context-usage ring. Extracted from TaskComposerFields.tsx to keep
 * every module under the 300-line AGENTS.md section 2 limit.
 */
import type { LlmConfig, Repository, TaskThinkingLevel } from '@/lib/hooks';
import { ringTone, type RingTone } from '@/lib/prompt-composer';
import { ProviderIcon } from '@/lib/providers';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function ComposerRepoSelect({
  repositories,
  repositoryId,
  onChange,
}: {
  repositories: Repository[];
  repositoryId: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={repositoryId} onValueChange={onChange} disabled={repositories.length === 0}>
      <SelectTrigger className="h-8 w-40 shrink-0" aria-label="Repository">
        <SelectValue placeholder="Select a repository…" />
      </SelectTrigger>
      <SelectContent>
        {repositories.map((repo) => (
          <SelectItem key={repo.id} value={repo.id}>
            <span className="flex items-center gap-2">
              <ProviderIcon provider={repo.connection.provider} className="h-3.5 w-3.5" />
              <span className="truncate">{repo.fullName}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function LlmConfigSelect({
  configs,
  value,
  onChange,
}: {
  configs: LlmConfig[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(v) => onChange(v === 'default' ? null : v)}
      disabled={configs.length === 0}
    >
      <SelectTrigger className="h-8 w-40 shrink-0" aria-label="Model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default model</SelectItem>
        {configs.map((config) => (
          <SelectItem key={config.id} value={config.id}>
            <span className="truncate">
              {config.name} · {config.model}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ThinkingLevelSelect({
  value,
  onChange,
}: {
  value: TaskThinkingLevel | null;
  onChange: (level: TaskThinkingLevel | null) => void;
}) {
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(v) => onChange(v === 'default' ? null : (v as TaskThinkingLevel))}
    >
      <SelectTrigger className="h-8 w-28 shrink-0" aria-label="Thinking level">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Default</SelectItem>
        <SelectItem value="low">Low</SelectItem>
        <SelectItem value="medium">Medium</SelectItem>
        <SelectItem value="high">High</SelectItem>
        <SelectItem value="max">Max</SelectItem>
      </SelectContent>
    </Select>
  );
}

const RING_TONE_CLASS: Record<RingTone, string> = {
  muted: 'stroke-muted-foreground',
  amber: 'stroke-amber-500',
  red: 'stroke-destructive',
};

/** Circular gauge of the estimated prompt-token share of the context window. */
export function ContextRing({ tokens, contextWindow }: { tokens: number; contextWindow: number | null }) {
  if (contextWindow === null || contextWindow <= 0) return null;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const ratio = tokens / contextWindow;
  const filled = Math.min(1, ratio) * circumference;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <svg
            width={20}
            height={20}
            viewBox="0 0 20 20"
            role="img"
            aria-label="Estimated context usage"
            className="shrink-0"
          >
            <circle cx={10} cy={10} r={radius} fill="none" strokeWidth={2.5} className="stroke-muted" />
            <circle
              cx={10}
              cy={10}
              r={radius}
              fill="none"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference}`}
              transform="rotate(-90 10 10)"
              className={RING_TONE_CLASS[ringTone(ratio)]}
            />
          </svg>
        </TooltipTrigger>
        <TooltipContent>
          ≈{tokens.toLocaleString()} tokens of {contextWindow.toLocaleString()}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
