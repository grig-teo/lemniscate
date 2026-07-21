import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  useRepositories,
  useUpdateAllRepositoryFlags,
  type Repository,
} from '@/lib/hooks';
import { initialFlags, setAutoReview, type RepoFlags } from '@/lib/repo-flags';

import { FlagSwitch } from '@/components/repo-tree/RepoRow';

type FlagSwitchProps = Parameters<typeof FlagSwitch>[0];

function FlagSetting({ description, ...switchProps }: { description: string } & FlagSwitchProps) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">{description}</p>
      <FlagSwitch {...switchProps} />
    </div>
  );
}

function FlagSwitches({
  flags,
  onChange,
}: {
  flags: RepoFlags;
  onChange: (flags: RepoFlags) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FlagSetting
        description="Push the finished branch and open a pull request on the git host (off: push the branch only)."
        label="PR"
        ariaLabel="Auto-create PR on all repositories"
        checked={flags.autoCreatePr}
        onChange={(autoCreatePr) => onChange({ ...flags, autoCreatePr })}
      />
      <FlagSetting
        description="After the PR opens, an LLM reviews the diff and can request fixes (up to 3 rounds)."
        label="review"
        ariaLabel="Auto-review PRs on all repositories"
        checked={flags.autoReviewPr}
        onChange={(checked) => onChange({ ...flags, ...setAutoReview(flags, checked) })}
      />
      <FlagSetting
        description="After review passes, merge automatically; conflicts are resolved by the LLM. Requires review."
        label="merge"
        ariaLabel="Auto-merge PRs on all repositories"
        checked={flags.autoMergePr}
        disabled={!flags.autoReviewPr}
        disabledTitle="Enable auto-review first"
        onChange={(autoMergePr) => onChange({ ...flags, autoMergePr })}
      />
    </div>
  );
}

function ApplyResult({ updateAll }: { updateAll: ReturnType<typeof useUpdateAllRepositoryFlags> }) {
  if (updateAll.isError) {
    return <p className="text-sm text-destructive">{updateAll.error.message}</p>;
  }
  if (updateAll.isSuccess) {
    return (
      <p className="text-sm text-muted-foreground">
        Updated {updateAll.data.updated} repositories
      </p>
    );
  }
  return null;
}

/** Initialize the switches once the first repo's flags arrive. */
function useInitialFlags(repos: Repository[] | undefined) {
  const [flags, setFlags] = React.useState<RepoFlags>(() => initialFlags(repos));
  const initialized = React.useRef(repos !== undefined);
  React.useEffect(() => {
    if (initialized.current || !repos) return;
    initialized.current = true;
    setFlags(initialFlags(repos));
  }, [repos]);
  return [flags, setFlags] as const;
}

/**
 * Repositories tab: bulk-apply PR / review / merge automation flags.
 * Applying rewrites these settings on ALL repositories.
 */
export function RepoFlagsSection() {
  const repos = useRepositories();
  const updateAll = useUpdateAllRepositoryFlags();
  const [flags, setFlags] = useInitialFlags(repos.data);

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        Applying rewrites these settings on ALL repositories.
      </p>

      <FlagSwitches
        flags={flags}
        onChange={(next) => {
          updateAll.reset();
          setFlags(next);
        }}
      />

      <div>
        <Button
          variant="outline"
          disabled={updateAll.isPending}
          onClick={() => updateAll.mutate(flags)}
        >
          Apply to all repositories
        </Button>
      </div>

      <ApplyResult updateAll={updateAll} />
    </div>
  );
}
