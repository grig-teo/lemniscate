import type { Repository } from '@/lib/hooks';

/**
 * Autonomous pipeline health derived from the Repository's
 * lastProposalAt / lastProposalError columns.
 *
 * - 'red'    — last generate-proposals attempt failed (lastProposalError set)
 * - 'amber'  — last success was more than 1 day ago (stale)
 * - 'green'  — last success was recent (< 1 day)
 * - 'none'   — never run AND no error: the pipeline has not attempted yet, or
 *              the repo is not opted into autoPropose / autoRunProposals.
 */
export type ProposalHealth = 'red' | 'amber' | 'green' | 'none';

const STALE_MS = 24 * 60 * 60 * 1000; // 1 day

export function proposalHealth(repo: Pick<Repository, 'autoPropose' | 'autoRunProposals' | 'lastProposalAt' | 'lastProposalError'>): ProposalHealth {
  // Only show the indicator when the repo is opted into autonomous proposals.
  if (!repo.autoPropose && !repo.autoRunProposals) return 'none';

  if (repo.lastProposalError) return 'red';
  if (!repo.lastProposalAt) return 'none';

  const ageMs = Date.now() - new Date(repo.lastProposalAt).getTime();
  return ageMs > STALE_MS ? 'amber' : 'green';
}

export const HEALTH_LABELS: Record<ProposalHealth, string> = {
  red: 'Proposal generation failed — check notification for details',
  amber: 'No new proposals recently (last run was over a day ago)',
  green: 'Pipeline healthy — proposals generated recently',
  none: '',
};
