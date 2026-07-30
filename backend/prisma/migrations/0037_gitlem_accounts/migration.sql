-- Gitlem: internal minimal git host with email+password registration.
--
-- * GitlemUser: one per Lemniscate user (userId unique). Holds the email the
--   code was sent to, the generated git username, and a scrypt password hash.
--   The password is generated and emailed; never stored plaintext or served.
-- * GitlemCode: one-time emailed 6-char registration/login codes, expiring
--   after config GITLEM_CODE_TTL_MINUTES and consumed on a single use.

CREATE TABLE "GitlemUser" (
    "id"           TEXT   NOT NULL,
    "userId"       TEXT   NOT NULL,
    "email"        TEXT   NOT NULL,
    "username"     TEXT   NOT NULL,
    "passwordHash" TEXT   NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitlemUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GitlemUser_userId_key" ON "GitlemUser"("userId");
CREATE UNIQUE INDEX "GitlemUser_email_key" ON "GitlemUser"("email");
CREATE UNIQUE INDEX "GitlemUser_username_key" ON "GitlemUser"("username");

CREATE TABLE "GitlemCode" (
    "id"         TEXT   NOT NULL,
    "email"      TEXT   NOT NULL,
    "code"       TEXT   NOT NULL,
    "purpose"    TEXT   NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitlemCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GitlemCode_email_idx" ON "GitlemCode"("email");

ALTER TABLE "GitlemUser"
  ADD CONSTRAINT "GitlemUser_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
