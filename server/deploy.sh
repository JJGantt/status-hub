#!/usr/bin/env bash
# Ship the hub to Fly, from whichever machine changed it.
#
# This replaced a GitHub Actions workflow on 2026-08-26. Actions cost more than it bought: during a
# platform outage push triggers silently stopped firing — a push succeeded, deployed nothing, and
# said nothing — and when the backlog drained it ran OUT OF ORDER, so a run for an older commit
# finished last and shipped that code over newer code that had already deployed.
#
# Deploying from the machine that made the change has neither failure mode, and both machines pull
# every 15 minutes so neither ships a stale tree. Actions now covers iOS only, where a macOS runner
# is genuinely required.
set -uo pipefail
cd "$(dirname "$0")" || exit 1

# WHAT SHIPS IS HEAD, never the working tree. Several sessions share this checkout, and a tree with
# someone's half-finished edit in it would otherwise go live under a commit that does not contain it.
SHA=$(git rev-parse --short HEAD)
[ -n "$(git status --porcelain .)" ] && echo "note: uncommitted changes under server/ are NOT deployed; shipping $SHA"
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
git -C .. archive HEAD server | tar -x -C "$BUILD" || { echo "could not export $SHA"; exit 1; }

# NEVER SHIP UNDER A COMMAND BEING SPOKEN OR SENT. A deploy restarts the hub and makes every open page
# reload: a page that reloads mid-recording loses the clip, and the restart cuts off any upload in flight.
# So the image is BUILT first (a remote build takes a minute or two, long enough for a command to start
# and finish inside it) and the wait runs right before the release, on two things:
#   - `voice_muted` is 1 exactly while some microphone (phone, watch, Mac) is capturing an explicit
#     command (stale holders are already discounted by the hub);
#   - /api/voice-inflight counts clips still uploading, which outlive the recording that made them.
# A bounded wait at deploy time, not a standing poll: 5s steps, ten minutes at most, then ship anyway.
# Unreadable (no supabase CLI, no link, hub down) means ship. macOS has no `timeout`, so it is not used:
# a check that cannot run reads as "not recording" and the wait silently does nothing.
(cd "$BUILD/server" && fly deploy --remote-only --build-only --push --image-label "$SHA") \
  || { echo "build FAILED"; exit 1; }
IMAGE="registry.fly.io/jared-status-hub:$SHA"
DL=$( [ -d "$HOME/repos/data-layer/supabase" ] && echo "$HOME/repos/data-layer" || echo "$HOME/data-layer" )
recording() {
  (cd "$DL" 2>/dev/null && supabase db query --linked \
    "select value from app_settings where key = 'voice_muted'" 2>/dev/null) | grep -q '"value": "1"'
}
uploading() {
  ../bin/hub GET /api/voice-inflight 2>/dev/null | grep -qE '"inflight": *[1-9]'
}
for i in $(seq 1 120); do
  recording || uploading || break
  [ "$i" = 1 ] && echo "a voice command is being recorded or uploaded — waiting for it before deploying"
  sleep 5
done

# COMMIT is what /healthz reports, and the only way to tell a deploy that shipped from one that did
# not. Verified below rather than assumed.
(cd "$BUILD/server" && fly deploy --image "$IMAGE" --env COMMIT="$SHA") || { echo "deploy FAILED"; exit 1; }

for _ in $(seq 1 20); do
  got=$(curl -s --max-time 10 https://jared-status-hub.fly.dev/healthz | awk '{print $2}')
  [ "$got" = "$SHA" ] && { echo "deployed and serving $SHA"; exit 0; }
  sleep 3
done
echo "DEPLOYED BUT NOT SERVING $SHA (got '${got:-nothing}') — check fly status -a jared-status-hub"
exit 1
