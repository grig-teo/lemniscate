import { useState } from 'react';
import { ChevronDown, ChevronRight, Settings } from 'lucide-react';

import { useUpdateRepositoryFlags, type Repository } from '@/lib/hooks';
import { setAutoReview } from '@/lib/repo-flags';
import { repoDisplayName } from '@/lib/repo-display';
import { cn } from '@/lib/utils';
import { RepoTasks } from '@/components/repo-tree/RepoTasks';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';

const SWITCH_CLASS =
  'h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3';

export function FlagSwitch({
  label,
  ariaLabel,
  checked,
  disabled,
  disabledTitle,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  checked: boolean;
  disabled?: boolean;
  disabledTitle?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-1.5 text-[11px] text-muted-foreground',
        disabled && 'opacity-50',
      )}
      title={disabled ? disabledTitle : undefined}
    >
      <Switch
        className={SWITCH_CLASS}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={ariaLabel}
      />
      {label}
    </label>
  );
}

function RepoFlags({ repo }: { repo: Repository }) {
  const updateFlags = useUpdateRepositoryFlags();
  const patch = (flags: Parameters<typeof updateFlags.mutate>[0]['patch']) =>
    updateFlags.mutate({ id: repo.id, patch: flags });

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-7 pr-1 pt-0.5">
      <FlagSwitch
        label="PR"
        ariaLabel={`Auto-create PR for ${repo.fullName}`}
        checked={repo.autoCreatePr}
        onChange={(checked) => patch({ autoCreatePr: checked })}
      />
      <FlagSwitch
        label="review"
        ariaLabel={`Auto-review PRs for ${repo.fullName}`}
        checked={repo.autoReviewPr}
        onChange={(checked) => patch(setAutoReview(repo, checked))}
      />
      <FlagSwitch
        label="merge"
        ariaLabel={`Auto-merge PRs for ${repo.fullName}`}
        checked={repo.autoMergePr}
        disabled={!repo.autoReviewPr}
        disabledTitle="Enable auto-review first"
        onChange={(checked) => patch({ autoMergePr: checked })}
      />
    </div>
  );
}

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
      <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent">
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
      </div>

      {settingsOpen && <RepoFlags repo={repo} />}

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
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm"
      aria-expanded={expanded}
    >
      <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{repoDisplayName(repo)}</span>
    </button>
  );
}
