import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

import { useGenerateProposals, useTasks } from '@/lib/hooks';
import { isPendingProposal, proposalPollInterval, PROPOSAL_TARGET_COUNT } from '@/lib/repo-tasks';
import { cn } from '@/lib/utils';

/** Give up waiting for generation results after this long. */
const GENERATION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Local "generation in flight" state: starts on click, stops when the pending
 * proposal count changes (fresh proposals arrived) or after a timeout.
 */
function useGenerationTracking(pendingCount: number) {
  const [generating, setGenerating] = useState(false);
  const startCountRef = useRef(pendingCount);

  useEffect(() => {
    if (generating && pendingCount !== startCountRef.current) setGenerating(false);
  }, [generating, pendingCount]);

  useEffect(() => {
    if (!generating) return;
    const timer = setTimeout(() => setGenerating(false), GENERATION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [generating]);

  return {
    generating,
    start: () => {
      startCountRef.current = pendingCount;
      setGenerating(true);
    },
    stop: () => setGenerating(false),
  };
}

/** Round button that enqueues proposal generation; badge shows "n/5" fresh proposals. */
export function GenerateProposalsButton({ repositoryId }: { repositoryId: string }) {
  const tasksQuery = useTasks(repositoryId, {
    refetchInterval: (query) => proposalPollInterval(query.state.data),
  });
  const generate = useGenerateProposals();
  const pendingCount = (tasksQuery.data ?? []).filter(isPendingProposal).length;
  const tracking = useGenerationTracking(pendingCount);
  // Spin whenever generation may be in flight — after a click, or while the
  // repo is short of fresh proposals (generation is automatic).
  const generating = tracking.generating || pendingCount < PROPOSAL_TARGET_COUNT;

  const onClick = () => {
    tracking.start();
    generate.mutate(repositoryId, { onError: tracking.stop });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={generating}
      aria-label={`Generate proposals (${pendingCount} of ${PROPOSAL_TARGET_COUNT})`}
      title="Generate proposals"
      className={cn(
        'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
        'border-border text-muted-foreground transition-colors hover:bg-accent',
        'disabled:cursor-not-allowed disabled:opacity-70',
        pendingCount < PROPOSAL_TARGET_COUNT && 'border-primary/60 text-primary',
        generating && 'animate-pulse',
      )}
    >
      <Sparkles className={cn('h-3.5 w-3.5', generating && 'animate-spin')} />
      <span className="absolute -right-1.5 -top-1.5 rounded-full bg-muted px-1 text-[9px] leading-3 text-muted-foreground">
        {pendingCount}/{PROPOSAL_TARGET_COUNT}
      </span>
    </button>
  );
}
