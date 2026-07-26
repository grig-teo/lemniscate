#!/bin/sh
# Test for the backup retention policy in scripts/backup.sh.
# Simulates 40 daily runs (40 backup sets spanning ~40 days), prunes, and
# asserts the directory stays bounded: 14 daily + up to 4 weekly per type.
# Runs under whatever sh invokes it (CI: also invoked via `busybox sh`).
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf 'ok: %s\n' "$*"; }

# epoch -> UTC YYYYMMDD-HHMMSS, GNU/BSD/busybox portable.
from_epoch() {
  date -u -d "@$1" +%Y%m%d-%H%M%S 2>/dev/null && return 0
  date -u -j -r "$1" +%Y%m%d-%H%M%S 2>/dev/null && return 0
  date -u -D "%s" -d "$1" +%Y%m%d-%H%M%S
}

NOW=$(date +%s)
# 40 simulated daily runs, 90000s apart (> 24h) to keep day boundaries
# unambiguous: indices 0..13 fall inside the 14-day window, 14..39 outside.
i=0
while [ "$i" -lt 40 ]; do
  TS=$(from_epoch $((NOW - i * 90000)))
  : > "$TEST_DIR/lemniscate-pg-$TS.sql.gz"
  : > "$TEST_DIR/lemniscate-minio-$TS.tar.gz"
  : > "$TEST_DIR/lemniscate-env-$TS.tar.gz"
  i=$((i + 1))
done
ok "created $(ls "$TEST_DIR" | wc -l | tr -d ' ') files (40 simulated runs x 3 types)"

BACKUP_DIR=$TEST_DIR sh "$SCRIPT_DIR/backup.sh" prune >/dev/null

count() { ls -1 "$TEST_DIR"/lemniscate-"$1"-* 2>/dev/null | wc -l | tr -d ' '; }

for type in pg minio env; do
  n=$(count "$type")
  [ "$n" -le 18 ] || fail "$type: $n files kept, expected <= 18 (14 daily + 4 weekly)"
  [ "$n" -ge 15 ] || fail "$type: only $n files kept, expected the 14-day window + >=1 weekly"
  ok "$type: $n files kept (bounded)"
done

# The newest backup of each type must survive; the oldest must be gone.
NEWEST=$(from_epoch "$NOW")
OLDEST=$(from_epoch $((NOW - 39 * 90000)))
[ -f "$TEST_DIR/lemniscate-pg-$NEWEST.sql.gz" ] || fail "newest pg backup was deleted"
ok "newest backup kept"
[ ! -f "$TEST_DIR/lemniscate-pg-$OLDEST.sql.gz" ] || fail "oldest pg backup survived pruning"
ok "oldest backup pruned"

# Every file inside the 14-day window must be kept.
i=0
while [ "$i" -lt 14 ]; do
  TS=$(from_epoch $((NOW - i * 90000)))
  [ -f "$TEST_DIR/lemniscate-pg-$TS.sql.gz" ] || fail "day-$i backup inside retention window was deleted"
  i=$((i + 1))
done
ok "all 14 daily backups inside the window kept"

# Total directory size stays bounded regardless of run count.
total=$(ls "$TEST_DIR" | wc -l | tr -d ' ')
[ "$total" -le 54 ] || fail "directory not bounded: $total files"
ok "total $total files <= 54 (18 per type)"

# Pruning twice is a no-op (idempotent).
before=$(ls "$TEST_DIR" | wc -l)
BACKUP_DIR=$TEST_DIR sh "$SCRIPT_DIR/backup.sh" prune >/dev/null
after=$(ls "$TEST_DIR" | wc -l)
[ "$before" = "$after" ] || fail "prune is not idempotent ($before -> $after)"
ok "prune is idempotent"

printf 'ALL RETENTION TESTS PASSED\n'
