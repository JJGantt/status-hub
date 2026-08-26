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
