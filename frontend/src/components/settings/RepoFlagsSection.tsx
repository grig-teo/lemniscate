import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useLlmConfigs,
  useRepositories,
  useUpdateAllRepositoryFlags,
  type LlmConfig,
  type Repository,
} from '@/lib/hooks';
import { initialFlags, setAutoReview, type RepoFlags } from '@/lib/repo-flags';

import { FlagSwitch } from '@/components/repo-tree/FlagSwitch';

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

/** Initialize local state once the repository list arrives (first repo wins). */
function useInitialFromRepos<T>(
  repos: Repository[] | undefined,
  read: (repos: Repository[] | undefined) => T,
) {
  const [value, setValue] = React.useState<T>(() => read(repos));
  const initialized = React.useRef(repos !== undefined);
  React.useEffect(() => {
    if (initialized.current || !repos) return;
    initialized.current = true;
    setValue(read(repos));
  }, [repos]);
  return [value, setValue] as const;
}

/** Initial switches: first repo's flags, else PR on / review off / merge off. */
function useInitialFlags(repos: Repository[] | undefined) {
  return useInitialFromRepos(repos, initialFlags);
}

/** Initial review LLM: the first repo's reviewLlmConfigId, else the default. */
function useInitialReviewLlm(repos: Repository[] | undefined) {
  return useInitialFromRepos(repos, (list) => list?.[0]?.reviewLlmConfigId ?? null);
}

/** Review-LLM picker: 'default' keeps the task → repo → user-default resolution. */
function ReviewLlmSelect({
  configs,
  value,
  onChange,
}: {
  configs: LlmConfig[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted-foreground">
        LLM that reviews pull requests and applies review fixes. Default: the task / repository
        model.
      </p>
      <Select value={value ?? 'default'} onValueChange={(v) => onChange(v === 'default' ? null : v)}>
        <SelectTrigger className="h-8" aria-label="Review LLM">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">Default (task / repository model)</SelectItem>
          {configs.map((config) => (
            <SelectItem key={config.id} value={config.id}>
              <span className="truncate">
                {config.name} · {config.model}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Repositories tab: bulk-apply PR / review / merge automation flags and the
 * review LLM. Applying rewrites these settings on ALL repositories.
 */
export function RepoFlagsSection() {
  const repos = useRepositories();
  const llmConfigs = useLlmConfigs();
  const updateAll = useUpdateAllRepositoryFlags();
  const [flags, setFlags] = useInitialFlags(repos.data);
  const [reviewLlmConfigId, setReviewLlmConfigId] = useInitialReviewLlm(repos.data);
  const enabledConfigs = React.useMemo(
    () => (llmConfigs.data ?? []).filter((config) => config.enabled),
    [llmConfigs.data],
  );

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

      <ReviewLlmSelect
        configs={enabledConfigs}
        value={reviewLlmConfigId}
        onChange={(id) => {
          updateAll.reset();
          setReviewLlmConfigId(id);
        }}
      />

      <div>
        <Button
          variant="outline"
          disabled={updateAll.isPending}
          onClick={() => updateAll.mutate({ ...flags, reviewLlmConfigId })}
        >
          Apply to all repositories
        </Button>
      </div>

      <ApplyResult updateAll={updateAll} />
    </div>
  );
}
