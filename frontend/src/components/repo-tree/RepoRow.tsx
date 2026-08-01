import { useState } from 'react';
import { ChevronDown, ChevronRight, GitMerge, Kanban, Settings } from 'lucide-react';

import { type Repository } from '@/lib/hooks';
import { repoDisplayName } from '@/lib/repo-display';
import { useWorkspaceSelection } from '@/lib/selection';
import { cn, hoverReveal } from '@/lib/utils';
import { RepoFlagsDropdown } from '@/components/repo-tree/RepoFlagsDropdown';
import { RepoTasks } from '@/components/repo-tree/RepoTasks';
import { Button } from '@/components/ui/button';
import { HEALTH_LABELS, proposalHealth } from '@/lib/proposal-health';

export function RepoRow({
  repo,
  expanded,
  onToggle,
}: {
  repo: Repository;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { openPrReview, openTaskBoard, taskBoardRepoId } = useWorkspaceSelection();
  const boardActive = taskBoardRepoId === repo.id;
  return (
    <div className="px-2 pb-2">
      <div className="group relative flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent">
        <RepoToggle repo={repo} expanded={expanded} onToggle={onToggle} />
        <Button
          variant={boardActive ? 'secondary' : 'ghost'}
          size="icon"
          className={cn('h-6 w-6 shrink-0', hoverReveal)}
          aria-label={`Task board for ${repo.fullName}`}
          title="Task board"
          onClick={() => openTaskBoard(repo.id)}
        >
          <Kanban className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6 shrink-0', hoverReveal)}
          aria-label={`Pull requests for ${repo.fullName}`}
          title="Pull requests"
          onClick={() => openPrReview(repo.id)}
        >
          <GitMerge className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-6 w-6 shrink-0', hoverReveal)}
          aria-label={`Settings for ${repo.fullName}`}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((prev) => !prev)}
        >
          <Settings className="h-3.5 w-3.5" />
        </Button>
        {settingsOpen && (
          <RepoFlagsDropdown repo={repo} onClose={() => setSettingsOpen(false)} />
        )}
      </div>

      {expanded && <RepoTasks repositoryId={repo.id} />}
    </div>
  );
}

function RepoToggle({
  repo,
  expanded,
  onToggle,
}: {
  repo: Repository;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { selectRepository } = useWorkspaceSelection();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const health = proposalHealth(repo);
  const handleClick = () => {
    onToggle();
    selectRepository(repo.id);
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
      aria-expanded={expanded}
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <HealthDot health={health} error={repo.lastProposalError} />
      <span className="truncate font-medium" title={repoDisplayName(repo)}>
        {repoDisplayName(repo)}
      </span>
    </button>
  );
}

const HEALTH_COLORS: Record<string, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
};

function HealthDot({ health, error }: { health: string; error?: string | null }) {
  if (health === 'none') return null;
  const tooltip = error
    ? `${HEALTH_LABELS[health as keyof typeof HEALTH_LABELS]}\n${error}`
    : HEALTH_LABELS[health as keyof typeof HEALTH_LABELS];
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_COLORS[health] ?? ''}`}
      title={tooltip}
      aria-label={HEALTH_LABELS[health as keyof typeof HEALTH_LABELS]}
    />
  );
}
