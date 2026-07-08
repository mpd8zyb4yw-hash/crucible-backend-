#!/usr/bin/env bash
# ── Crucible auto-sync ────────────────────────────────────────────────────────
# Keeps this checkout hard-synced to the dev branch and (re)runs the backend under
# `tsx watch`, so every pushed commit goes live here with no manual pull/restart.
#
# Use this when running the server WITHOUT the Electron app (the Electron app has the
# same pipeline built in — see electron.cjs `startAutoSync`). Run once:
#
#     ./autosync.sh
#
# It stays in the foreground and logs each sync. Ctrl-C to stop. Override the branch
# or poll interval with env vars:
#
#     CRUCIBLE_SYNC_BRANCH=some/branch SYNC_INTERVAL=10 ./autosync.sh
set -uo pipefail
cd "$(dirname "$0")"

BRANCH="${CRUCIBLE_SYNC_BRANCH:-claude/remote-brain-capture-latency-yeas6j}"
INTERVAL="${SYNC_INTERVAL:-15}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

log() { echo "[autosync $(date +%H:%M:%S)] $*"; }

# Make sure we're on the branch and current before starting the server.
git fetch origin "$BRANCH" --quiet || log "initial fetch failed (offline?) — continuing"
git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -B "$BRANCH" "origin/$BRANCH" --quiet
git reset --hard "origin/$BRANCH" --quiet
log "on $BRANCH @ $(git rev-parse --short HEAD)"

# tsx watch owns the single server process and restarts it on any file change (i.e. on
# every sync). Kill any stragglers from a previous run first.
pkill -f "tsx watch server.ts" 2>/dev/null || true
pkill -f "tsx server.ts" 2>/dev/null || true
sleep 1
npx tsx watch server.ts &
SERVER_PID=$!
log "server started under tsx watch (pid $SERVER_PID)"

cleanup() { log "stopping"; kill "$SERVER_PID" 2>/dev/null || true; exit 0; }
trap cleanup INT TERM

# Poll loop: hard-sync whenever the remote advances. tsx watch handles the restart.
while true; do
  sleep "$INTERVAL"
  git fetch origin "$BRANCH" --quiet || continue
  LOCAL="$(git rev-parse HEAD)"
  REMOTE="$(git rev-parse "origin/$BRANCH")"
  if [ "$LOCAL" != "$REMOTE" ]; then
    log "${LOCAL:0:7} → ${REMOTE:0:7} — syncing"
    git reset --hard "origin/$BRANCH" --quiet && log "synced; tsx watch will restart the server"
  fi
done
