-- Autonomous pipeline health: last successful generate-proposals timestamp
-- and the last scrubbed error message. Null until the first attempt; the
-- frontend shows a green (recent success) / amber (stale > 1 day) / red
-- (last attempt failed) health dot per repository based on these columns.

ALTER TABLE "Repository" ADD COLUMN "lastProposalAt"    TIMESTAMP(3);
ALTER TABLE "Repository" ADD COLUMN "lastProposalError" TEXT;
