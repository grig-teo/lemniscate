import type { Repository } from '@/lib/hooks';

/** The three per-repository automation flags. */
export type RepoFlags = Pick<Repository, 'autoCreatePr' | 'autoReviewPr' | 'autoMergePr'>;

/** Merging requires a review — turning review off also turns merge off. */
export function setAutoReview(
  flags: Pick<RepoFlags, 'autoMergePr'>,
  autoReviewPr: boolean,
): Pick<RepoFlags, 'autoReviewPr' | 'autoMergePr'> {
  return { autoReviewPr, autoMergePr: autoReviewPr ? flags.autoMergePr : false };
}

/** Initial switches: first repo's flags, else PR on / review off / merge off. */
export function initialFlags(repos: Repository[] | undefined): RepoFlags {
  const first = repos?.[0];
  if (!first) return { autoCreatePr: true, autoReviewPr: false, autoMergePr: false };
  return {
    autoCreatePr: first.autoCreatePr,
    autoReviewPr: first.autoReviewPr,
    autoMergePr: first.autoMergePr,
  };
}
