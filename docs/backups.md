# Backups and restore

Everything Lemniscate owns — user accounts, OAuth tokens, AES-encrypted LLM
API keys, repositories, tasks, proposals, service deployments — lives in two
Docker volumes (`pgdata`, `miniodata`) plus the checkout's env files. This
runbook covers the automated backup machinery in `scripts/` and the tested
restore procedure.

- **What is backed up**
  - Postgres: `pg_dump --clean --if-exists` of the whole database.
  - MinIO: `mc mirror` of every bucket into a tarball.
  - Env files: `.env`, `backend/.env`, `frontend/.env` (host runs only).
- **Where**: `./backups/` (gitignored, `chmod 700`, files `chmod 600`),
  configurable via `BACKUP_DIR`.
- **Retention**: all backups from the last 14 days, plus the newest backup
  per 7-day bucket for 4 further weeks. Configurable via `RETENTION_DAILY`
  / `RETENTION_WEEKLY`. Bounded: at most 18 backup sets.
- **RPO**: 24h with the default daily schedule.

## Why the env backup matters (read this once)

LLM API keys and OAuth tokens in the database are AES-256-GCM encrypted with
`ENCRYPTION_KEY` from `backend/.env` (see `backend/src/lib/crypto.ts`). The
dump therefore contains only ciphertext — good for confidentiality — but it
also means **a database dump without `backend/.env` cannot decrypt any stored
secret**: after a restore onto a fresh machine without the env files, every
user must re-enter every LLM key and reconnect every git host by hand. Always
copy the env tarball (or at least `backend/.env`) off the host together with
the data backups.

## Quick start

One-shot backup (run in the checkout on the VPS):

```sh
scripts/backup.sh            # or: scripts/backup.sh run
scripts/backup.sh list       # show what exists
```

Scheduled backups — two options, pick one:

**A. Compose sidecar (no host dependencies).** A small `docker:cli` container
runs the same `scripts/backup.sh` daily:

```sh
docker compose --profile backup up -d
docker compose --profile backup logs -f backup
```

The sidecar discovers its own compose project from its container labels and
uses the docker socket (same trust level as `backend`/`worker`, which already
mount it). Interval: `BACKUP_INTERVAL_SECONDS` (default 86400).

Note: by design the sidecar cannot read the checkout's `.env` files, so its
runs skip the env tarball. To capture env files regularly, use option B on
the host (or run `scripts/backup.sh` manually after changing secrets).

**B. Host cron:**

```sh
crontab -e
# m h dom mon dow command
15 3 * * *  cd /opt/lemniscate && ./scripts/backup.sh >> backups/cron.log 2>&1
```

## Off-host copy (do this — a backup on the same disk is not a backup)

```sh
# scp, nightly from another machine:
scp -rq vps:/opt/lemniscate/backups/ ./lemniscate-backups/

# or rclone to object storage:
rclone sync /opt/lemniscate/backups remote:lemniscate-backups
```

The backups hold ciphertext secrets and OAuth refresh tokens — treat them as
sensitive: keep `backups/` at `chmod 700` (the script does this), and encrypt
off-host copies, e.g. `tar -cz backups | gpg -c > backups.tar.gz.gpg` or an
age/rclone-crypt remote.

## Excluding the artifact bucket

The `device-artifacts` bucket (APK/IPA build outputs) is expendable — objects
there already expire via `DEVICE_ARTIFACT_TTL_DAYS` — and can be large. Skip
it to keep backups small:

```sh
MINIO_EXCLUDE='device-artifacts*' scripts/backup.sh
# or persistently, in the root .env (the sidecar reads it too):
echo "MINIO_EXCLUDE=device-artifacts*" >> .env
```

## Restore procedure

On the machine you are restoring to (same checkout layout; stack cloned and
`.env` present if you have it):

```sh
# 1. Get the backups onto the machine (scp/rclone from your off-host copy).
ls backups/

# 2. Bring up only the data services on a fresh machine:
docker compose up -d postgres minio
#    On an existing (damaged) install this step is a no-op; the restore
#    script stops backend/worker/frontend/traefik itself.

# 3. Restore (add --with-env on a FRESH machine to also restore .env files):
scripts/restore.sh 20260726-030000 --with-env
#    or: scripts/restore.sh latest        (interactive confirmation)
#    or: scripts/restore.sh latest --yes  (automation)

# 4. The script restarts the stack and polls /health/ready. Confirm:
curl -fsS http://127.0.0.1:3000/health/ready
```

What the script does, in order: asks for typed confirmation (unless `--yes`)
→ stops `backend`, `worker`, `frontend`, `traefik` → pipes the dump into
`psql -v ON_ERROR_STOP=1` (any failed statement aborts the restore) →
recreates each MinIO bucket and mirrors the objects back with `--overwrite` →
optionally restores the env files → starts the stack (`docker compose up -d`)
→ waits for Postgres `pg_isready` and, when a backend container exists, polls
`/health/ready` for up to 2 minutes, exiting non-zero on failure.

After a successful restore, log in with a pre-existing account and check
Settings → repositories and LLM configs. If LLM keys fail test-connection
after restoring onto a new machine, the cause is almost always a missing or
different `ENCRYPTION_KEY` — restore the env tarball (`--with-env`) or copy
`backend/.env` from your off-host copy and `docker compose up -d` again.

## Restore drill (test procedure — run it after every major change)

The drill is the test. It proves a destroyed deployment comes back. Recorded
runs live at the bottom of this file.

```sh
# Use a throwaway compose project so the drill can never touch real data.
export COMPOSE_PROJECT_NAME=backupdrill

# 1. Fresh data services only:
docker compose up -d postgres minio

# 2. Seed data (a table + row in Postgres, a bucket + object in MinIO):
docker exec -i backupdrill-postgres-1 psql -U lemniscate -d lemniscate <<'SQL'
CREATE TABLE drill_users (id serial primary key, email text, token_ciphertext text);
INSERT INTO drill_users VALUES (1, 'drill@example.com', 'ciphertext-blob');
SQL
docker run --rm --network backupdrill_default --entrypoint sh \
  minio/mc:RELEASE.2025-08-13T08-35-41Z -c '
    mc alias set local http://minio:9000 lemniscate lemniscate-minio >/dev/null &&
    mc mb -p local/lemniscate-library >/dev/null &&
    echo "skill: drill-v1" | mc pipe local/lemniscate-library/skills/drill.md'

# 3. Back up:
scripts/backup.sh

# 4. Destroy everything (volumes included):
docker compose down -v
docker compose up -d postgres minio

# 5. Restore and verify:
scripts/restore.sh latest --yes
docker exec backupdrill-postgres-1 psql -U lemniscate -d lemniscate \
  -c 'SELECT * FROM drill_users;'          # expect the seeded row
docker run --rm --network backupdrill_default --entrypoint sh \
  minio/mc:RELEASE.2025-08-13T08-35-41Z -c '
    mc alias set local http://minio:9000 lemniscate lemniscate-minio >/dev/null &&
    mc cat local/lemniscate-library/skills/drill.md'   # expect: skill: drill-v1

# 6. Clean up:
docker compose down -v
unset COMPOSE_PROJECT_NAME
```

On a full install (backend built), additionally assert after step 5:
`curl -fsS http://127.0.0.1:3000/health/ready`, log in with a pre-drill
account, and confirm the repository list and an LLM config test-connection —
this exercises the `ENCRYPTION_KEY` handling end to end.

## Retention test

```sh
sh scripts/test-backup-retention.sh        # also: busybox sh ...
```

Simulates 40 daily runs (120 files), prunes, and asserts the directory stays
bounded (14 daily + 4 weekly per type), the newest file survives, the oldest
is deleted, and pruning is idempotent.

## Troubleshooting

- **`no running 'postgres' container found`** — run the script from the
  checkout of the stack you mean to back up, or set
  `COMPOSE_PROJECT_NAME=<project>` explicitly.
- **Restore aborts with a psql error** — the dump is applied with
  `ON_ERROR_STOP=1`; the database may be partially restored. Fix the cause
  (usually a version mismatch) and re-run the same restore; the `--clean`
  dump drops existing objects first, so restores are repeatable.
- **Empty MinIO archive after backup** — check `docker compose logs minio`
  and that `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` in `.env` match the
  running server.
- **Sidecar skips env backup** — expected; see "Quick start", option A.

## Recorded drills

- **2026-07-26** — full cycle on the reference implementation
  (`backupdrill` project, postgres:16-alpine +
  minio:RELEASE.2025-09-07T16-13-09Z): seeded row + object →
  `scripts/backup.sh` (1.3s; pg 4.0K, minio 4.0K, env 2.2K) →
  `docker compose down -v` → `scripts/restore.sh latest --yes` (2s) → seeded
  row and object verified byte-identical. Sidecar path verified separately in
  a `docker:27-cli` container (project self-discovery via labels, exit 0).
  Retention test: 40 simulated runs → 18 files per type, idempotent, passes
  under `sh` and `busybox sh`.
