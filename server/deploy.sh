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

[ -n "$(git status --porcelain .)" ] && echo "warning: uncommitted changes under server/ — deploying the working tree, not a commit"
SHA=$(git rev-parse --short HEAD)

# NEVER SHIP UNDER A COMMAND BEING SPOKEN. A deploy restarts the hub and makes every open page reload,
# and a page that reloads mid-recording loses the clip. The page now holds its reloads off while it is
# recording (safeReload in public/shared.js), but a phone still running the bundle from before that
# does not, and the restart itself drops any upload in flight. `voice_muted` is 1 exactly while some
# microphone — phone, watch, Mac — is capturing an explicit command (stale holders are already
# discounted by the hub), so wait for it to clear. A bounded wait at deploy time, not a standing poll:
# 5s steps, ten minutes at most, then ship anyway. Unreadable (no supabase CLI, no link) means ship.
DL=$( [ -d "$HOME/repos/data-layer/supabase" ] && echo "$HOME/repos/data-layer" || echo "$HOME/data-layer" )
recording() {
  (cd "$DL" 2>/dev/null && timeout 30 supabase db query --linked \
    "select value from app_settings where key = 'voice_muted'" 2>/dev/null) | grep -q '"value": "1"'
}
for i in $(seq 1 120); do
  recording || break
  [ "$i" = 1 ] && echo "a voice command is being recorded — waiting for it to finish before deploying"
  sleep 5
done

# COMMIT is what /healthz reports, and the only way to tell a deploy that shipped from one that did
# not. Verified below rather than assumed.
fly deploy --remote-only --env COMMIT="$SHA" || { echo "deploy FAILED"; exit 1; }

for _ in $(seq 1 20); do
  got=$(curl -s --max-time 10 https://jared-status-hub.fly.dev/healthz | awk '{print $2}')
  [ "$got" = "$SHA" ] && { echo "deployed and serving $SHA"; exit 0; }
  sleep 3
done
echo "DEPLOYED BUT NOT SERVING $SHA (got '${got:-nothing}') — check fly status -a jared-status-hub"
exit 1
