import { useState } from 'react';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';

import { type Repository } from '@/lib/hooks';
import { repoDisplayName } from '@/lib/repo-display';
import { useWorkspaceSelection } from '@/lib/selection';
import { RepoFlagsDropdown } from '@/components/repo-tree/RepoFlagsDropdown';
import { RepoTasks } from '@/components/repo-tree/RepoTasks';
import { Button } from '@/components/ui/button';

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
  return (
    <div className="px-2 pb-2">
      <div className="relative flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent">
        <RepoToggle repo={repo} expanded={expanded} onToggle={onToggle} />
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
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
      <span className="truncate font-medium" title={repoDisplayName(repo)}>
        {repoDisplayName(repo)}
      </span>
    </button>
  );
}
