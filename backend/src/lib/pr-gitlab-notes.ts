import type { PrConnectionInput, PrReviewComment, PullRequestRefInput } from './pr-shared.js';
import { gitlabGet, gitlabLookupMrIid, gitlabMrsUrl } from './pr-gitlab.js';
import { mapGitlabMrNotes } from './review-feedback.js';

// Human notes on the MR (the pr-state-sync poll fallback for hosts without
// webhooks). Split from pr-gitlab.ts to keep that module under the §2 file
// limit; the MR helpers stay in their home module and are imported here.
// System notes ("added 1 commit", "mentioned in …") are provider
// bookkeeping — mapGitlabMrNotes drops them.
export async function gitlabReviewComments(
  connection: PrConnectionInput,
  token: string,
  input: PullRequestRefInput,
): Promise<PrReviewComment[]> {
  const { iid } = await gitlabLookupMrIid(connection, token, input);
  const url = `${gitlabMrsUrl(connection, input.repoFullName)}/${iid}/notes?per_page=100&sort=asc`;
  const { body } = await gitlabGet(connection, token, url);
  return mapGitlabMrNotes(body);
}
