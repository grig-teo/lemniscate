import type { Repository } from '@/lib/hooks';

/** The per-repository automation flags shown in the bulk settings section. */
export type RepoFlags = Pick<
  Repository,
  'autoCreatePr' | 'autoReviewPr' | 'autoMergePr' | 'autoAddressReview'
>;

/** Merging requires a review — turning review off also turns merge off. */
export function setAutoReview(
  flags: Pick<RepoFlags, 'autoMergePr'>,
  autoReviewPr: boolean,
): Pick<RepoFlags, 'autoReviewPr' | 'autoMergePr'> {
  return { autoReviewPr, autoMergePr: autoReviewPr ? flags.autoMergePr : false };
}

/** Initial switches: first repo's flags, else PR on / everything else off. */
export function initialFlags(repos: Repository[] | undefined): RepoFlags {
  const first = repos?.[0];
  if (!first) {
    return { autoCreatePr: true, autoReviewPr: false, autoMergePr: false, autoAddressReview: false };
  }
  return {
    autoCreatePr: first.autoCreatePr,
    autoReviewPr: first.autoReviewPr,
    autoMergePr: first.autoMergePr,
    autoAddressReview: first.autoAddressReview,
  };
}

/** One per-repository automation flag shown in the repo settings dropdown. */
export interface RepoFlagInfo {
  key: 'autoCreatePr' | 'autoReviewPr' | 'autoMergePr' | 'autoRunProposals' | 'autoAddressReview';
  label: string;
  /** What the flag does, including the on/off behavior, shown via the info button. */
  description: string;
}

/** Labels + descriptions for every repo automation toggle, in display order. */
export const REPO_FLAG_INFO: RepoFlagInfo[] = [
  {
    key: 'autoCreatePr',
    label: 'PR',
    description:
      'On: when a task finishes, its branch is pushed and a pull request is opened on the git host. Off: the branch is only pushed — no PR is created.',
  },
  {
    key: 'autoReviewPr',
    label: 'review',
    description:
      'On: after a task finishes, the LLM reviews the changes automatically. Off: no review happens. Turning review off also turns merge off, because merging requires a review.',
  },
  {
    key: 'autoMergePr',
    label: 'merge',
    description:
      'On: after a successful review the pull request is merged into the default branch automatically; conflicts are resolved by the LLM. Requires review to be on. Off: pull requests wait for you to merge them manually.',
  },
  {
    key: 'autoRunProposals',
    label: 'auto-run',
    description:
      'On: every 20 minutes one pending proposal is started automatically, one at a time. Off: proposals only run when you start them yourself.',
  },
  {
    key: 'autoAddressReview',
    label: 'feedback',
    description:
      'On: when a human writes a review comment on the agent\'s pull request, the agent addresses it with a follow-up commit. Off (default): human review comments are left for you — the agent does not act on them.',
  },
];
