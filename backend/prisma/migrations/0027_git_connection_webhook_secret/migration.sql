-- Inbound git-provider webhook receiver: each GitConnection may store an
-- encrypted shared secret used to verify the provider's webhook signature
-- (GitHub X-Hub-Signature-256 HMAC, GitLab X-Gitlab-Token). When null, the
-- webhook endpoint answers 401 and the 5-min pr-state-sync poller remains the
-- only source of PR-state transitions for that connection.

ALTER TABLE "GitConnection" ADD COLUMN "webhookSecretEnc" TEXT;
