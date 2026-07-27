import type { Job } from 'bullmq';
import {
  generateProposals,
  stampProposalFailure,
  stampProposalSuccess,
} from './agent-proposals.js';
import {
  notifyProposalGenerationFailure,
  scrubRepositoryFailureMessage,
} from './notifications.js';
import { errorMessage } from './utils.js';

// Wraps generateProposals with pipeline-health side effects: stamps
// lastProposalAt on success and lastProposalError on every failure, and
// emits a proposal_generation_failed notification only on the final retry
// attempt (so transient blips that recover do not alarm the user).
// The raw worker-level error is scrubbed ONCE against the owner's
// tokens/keys and the scrubbed text is used for both the persisted stamp
// (served by GET /repositories, rendered in the RepoRow tooltip) and the
// notification body.
// The generic job_failed path in notifyJobFailure is skipped for this job
// name (see notifications.ts) to avoid a duplicate notification.
function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts?.attempts ?? 1);
}

export async function runGenerateProposals(repositoryId: string, job: Job): Promise<void> {
  try {
    await generateProposals(repositoryId);
    await stampProposalSuccess(repositoryId);
  } catch (err) {
    const message = await scrubRepositoryFailureMessage(repositoryId, errorMessage(err));
    await stampProposalFailure(repositoryId, message);
    if (isFinalAttempt(job)) {
      await notifyProposalGenerationFailure(repositoryId, message);
    }
    throw err;
  }
}
