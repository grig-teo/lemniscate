import { useRef, useState } from 'react';
import { Info } from 'lucide-react';

import { useUpdateRepositoryFlags, type Repository } from '@/lib/hooks';
import { REPO_FLAG_INFO, setAutoReview, type RepoFlagInfo } from '@/lib/repo-flags';
import { useCloseOnOutside } from '@/lib/use-close-on-outside';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';

const SWITCH_CLASS =
  'h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3';

type FlagsPatch = Parameters<ReturnType<typeof useUpdateRepositoryFlags>['mutate']>[0]['patch'];

function flagPatch(repo: Repository, info: RepoFlagInfo, checked: boolean): FlagsPatch {
  return info.key === 'autoReviewPr' ? setAutoReview(repo, checked) : { [info.key]: checked };
}

/** One toggle row: label, switch, and an info button that reveals the description. */
function FlagRow({ repo, info }: { repo: Repository; info: RepoFlagInfo }) {
  const updateFlags = useUpdateRepositoryFlags();
  const [infoOpen, setInfoOpen] = useState(false);
  const mergeBlocked = info.key === 'autoMergePr' && !repo.autoReviewPr;
  return (
    <div className="px-1 py-0.5">
      <div className="flex items-center gap-1.5">
        <span className="flex-1 text-xs">{info.label}</span>
        <Switch
          className={SWITCH_CLASS}
          checked={repo[info.key]}
          disabled={mergeBlocked}
          title={mergeBlocked ? 'Enable auto-review first' : undefined}
          onCheckedChange={(checked) =>
            updateFlags.mutate({ id: repo.id, patch: flagPatch(repo, info, checked) })
          }
          aria-label={`${info.label} automation for ${repo.fullName}`}
        />
        <button
          type="button"
          onClick={() => setInfoOpen((open) => !open)}
          aria-expanded={infoOpen}
          aria-label={`About the ${info.label} toggle`}
          className={cn(
            'rounded p-0.5 text-muted-foreground/70 hover:text-muted-foreground',
            infoOpen && 'text-foreground',
          )}
        >
          <Info className="h-3 w-3" aria-hidden />
        </button>
      </div>
      {infoOpen && (
        <p className="pt-0.5 text-[11px] leading-snug text-muted-foreground/80">
          {info.description}
        </p>
      )}
    </div>
  );
}

/**
 * Anchored dropdown with the repo's automation toggles (PR/review/merge/auto-run),
 * each with an info button describing the on/off behavior. Spans the repo row so
 * it follows the sidebar width; closes on outside click or Escape.
 */
export function RepoFlagsDropdown({ repo, onClose }: { repo: Repository; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useCloseOnOutside(ref, onClose);
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Settings for ${repo.fullName}`}
      className="absolute inset-x-0 top-full z-50 mt-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-md"
    >
      {REPO_FLAG_INFO.map((info) => (
        <FlagRow key={info.key} repo={repo} info={info} />
      ))}
    </div>
  );
}
