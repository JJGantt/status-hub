# CI results go back to the session that pushed

GitHub Actions runs each repo's tests on every push to `main`. This sends a failed run to the Claude
session whose push it was, so the session that broke something fixes it while it still has the
context, and nobody depends on GitHub's email.

```
git push ──pre-push hook──▶ POST /api/ci/pushes ──▶ ci_pushes (repo, sha → conversation)
GitHub Actions run ──workflow_run webhook──▶ POST /api/ci/github ──▶ ci_runs
                                                   │ failed, push to the default branch
                                                   ▼
                       follow-up to that conversation (followUpSession, routes/sessions.js)
                       else a new session in the repo ("Fix CI: <repo> <sha>")
                       else reported to the ops responder
```

- **The record of who pushed.** Commits carry no session id (no attribution lines), so the link is
  made at push time: `claude-config/shared/git-hooks/pre-push` posts the pushed sha with
  `CLAUDE_CODE_SESSION_ID` (which is `desk_sessions.claude_session_id`) through
  `claude-config/shared/bin/ci-record-push`. It runs in the background and never blocks a push. A
  push by hand records no conversation, and its failures go to a new session.
- **The webhook.** `POST /api/ci/github` is on `pub`: GitHub carries no hub credential, so the HMAC
  over the raw body with `GITHUB_WEBHOOK_SECRET` (a Fly secret; the Mac's copy is
  `~/.config/ci/github-webhook-secret`) is the auth. Only `workflow_run` is acted on.
- **The rules** are `lib/ci.js`, tested in `test/ci.test.js`:
  - `failure`, `timed_out` and `startup_failure` are failures. `cancelled`, `skipped` and `neutral`
    are someone's choice and send nothing.
  - Only a push to the repo's default branch is routed. A pull request or another branch is recorded
    with `routed = skipped:…`.
  - The conversation's newest resident or parked row gets the follow-up, so a parked session is
    resumed with it; a session whose machine is down moves to one that is up with it (the hub's
    `followUpSession`). A follow-up saved because no machine could take it counts as delivered. An
    ended session, no record, or a follow-up refused outright starts a new session on the Pi, else the
    Mac, else Fly; only when none takes it is it dead-lettered and reported.
  - A run is started by `requested` (a new run) or `in_progress` (a re-run, which keeps the run id with a
    higher attempt and sends no `requested`). Deliveries can arrive out of order, so a start for an
    attempt already recorded changes nothing.
  - GitHub waits 10s for each delivery and never retries, so a `completed` sent while the hub is
    deploying is lost. When the hub starts it asks GitHub (`GH_TOKEN`, read-only use) about every run
    still open and applies any that finished, routing a failure as if the delivery had come
    (`reconcile`).
  - A run started and not completed after two hours is reported to the responder once. It is checked
    whenever any webhook arrives, which is the next evidence there is. GitHub is asked first: a run it
    has completed is routed, and reported as a lost delivery; one it does not is reported as never
    completed. Without `GH_TOKEN` only the report happens, and the hub logs an error at start.
- **Not the incident agent.** It cannot edit or push (health/responder README § permissions), and a
  red test needs both. The responder hears only when no session could be given the failure.
- **What the session is told** is `prompts()` in `lib/ci.js`: read the failed log, re-run it if GitHub
  itself failed (no runner acquired), otherwise fix the code or the tests, and add cases for rule logic
  its own push introduced. A GitHub-side failure (a macOS runner never acquired) arrives as a failure
  like any other; the session re-runs it.

`ci_runs.routed` is the record of what happened to each failure: `session:<conversation>`,
`saved:<conversation>`, `new:<command id>`, `skipped:…` or `unrouted:…`.

## Setup

- **The hook, per machine:** `claude-config/install.sh` sets `git config --global core.hooksPath` to
  `shared/git-hooks`. The other hook names there run the repository's own `.git/hooks`, which that
  setting would otherwise silence. A repository with its own `core.hooksPath` keeps it, and records
  nothing.
- **The webhook, per repo:** `bin/ci-webhooks` adds it to every JJGantt repo that has workflows, and
  updates one already there. Run it again after giving a repo its first workflow.
