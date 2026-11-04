'use strict';
// CI RESULTS GO BACK TO THE SESSION THAT PUSHED (docs/CI.md).
//
// Two inputs. The git pre-push hook on every machine (claude-config shared/git-hooks/pre-push) records
// which conversation pushed which commit (`recordPush`, table ci_pushes). GitHub's workflow_run webhook
// reports each run as it is requested and completed (`onWorkflowRun`, table ci_runs). A failed run on a
// push to the default branch is typed into that conversation as a follow-up; when it cannot be reached
// (ended, never recorded, a push by hand) a new session is started in the repo to fix it. The
// incident agent is not used: it cannot edit or push, and a red test needs exactly that.
//
// Everything outside this file is passed in, so the routing rules are tested without the network
// (test/ci.test.js).
const crypto = require('crypto');

// A run requested this long ago with no completion is a run whose result never arrived.
const MISSING_AFTER_MS = 2 * 3600e3;
// Conclusions that need a session. cancelled, skipped and neutral are someone's choice, not a break.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

function verifySignature(secret, raw, header) {
  if (!secret || !header || !Buffer.isBuffer(raw)) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(String(header)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function prompts({ repo, sha, workflow, runId, url }) {
  const s7 = sha.slice(0, 7);
  const read = `Read it with \`gh run view ${runId} -R ${repo} --log-failed\`. If GitHub itself failed (no runner acquired, runner lost), re-run it with \`gh run rerun ${runId} -R ${repo} --failed\` and stop there.`;
  const fix = 'Otherwise fix whichever is wrong, the code or the tests, and push. Tests for behaviour you changed on purpose are updated, not deleted; if the work in this push added rule logic no test covers, add cases for it.';
  return {
    followUp: `[CI] The "${workflow}" run failed on ${repo} for your push of ${s7} (${url}). ${read} ${fix}`,
    fresh: `[CI] The "${workflow}" run failed on ${repo} for ${s7} (${url}), and the session that pushed it is not running. ${read} ${fix} The commit's message and diff (\`git show ${s7}\`) say what it was for.`,
  };
}

/**
 * deps:
 *   db.upsert(table, row) / db.select(path) / db.patch(path, body)
 *   followUp(row, text)          -> {status, body}   (routes/sessions.js followUpSession)
 *   startFix(repoName, prompt, label) -> {ok, id?, error?}
 *   report(message, context)     the ops responder
 *   now()                        ms
 */
function createCi(deps) {
  const { db, followUp, startFix, report, now = Date.now } = deps;

  async function recordPush(body) {
    const b = body || {};
    const repo = String(b.repo || ''), sha = String(b.sha || '').toLowerCase();
    if (!REPO_RE.test(repo) || !SHA_RE.test(sha)) return { status: 400, body: { error: 'repo (owner/name) and a full sha required' } };
    const str = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
    await db.upsert('ci_pushes', {
      repo, sha, branch: str(b.branch, 200), claude_session_id: str(b.claude_session_id, 80),
      hub_session_id: str(b.hub_session_id, 80), machine: str(b.machine, 20), pushed_at: new Date(now()).toISOString(),
    });
    return { status: 200, body: { ok: true } };
  }

  // The conversation's newest row that can still take words, or null.
  async function reachable(conv) {
    const rows = await db.select(`desk_sessions?claude_session_id=eq.${encodeURIComponent(conv)}`
      + '&status=in.(resident,evicted)&select=*&order=started.desc&limit=1');
    return rows[0] || null;
  }

  async function routeFailure(run) {
    const { repo, sha } = run;
    const text = prompts(run);
    const pushed = (await db.select(`ci_pushes?repo=eq.${encodeURIComponent(repo)}&sha=eq.${sha}&select=claude_session_id`))[0];
    const conv = pushed && pushed.claude_session_id;
    const row = conv ? await reachable(conv) : null;
    if (row) {
      const r = await followUp(row, text.followUp);
      if (r.status === 200) return `session:${conv}`;
      // A 409 whose words were saved (machine asleep, dead-lettered) is still delivered later.
      if (r.body && r.body.saved) return `saved:${conv}`;
    }
    const name = repo.split('/')[1];
    const s = await startFix(name, text.fresh, `Fix CI: ${name} ${sha.slice(0, 7)}`);
    if (s.ok) return `new:${s.id}`;
    report(`CI failure on ${repo} ${sha.slice(0, 7)} could not be sent to any session: ${s.error}`,
           { context: `${run.workflow} ${run.url}; pushed by ${conv || 'nobody recorded'}` });
    return `unrouted:${s.error}`.slice(0, 300);
  }

  // Runs requested long ago that never completed: GitHub lost the run, or the hub lost its webhook.
  // Checked whenever any webhook arrives, which is the next evidence there is.
  async function checkMissing() {
    const before = new Date(now() - MISSING_AFTER_MS).toISOString();
    const stuck = await db.select(`ci_runs?completed_at=is.null&missing_reported_at=is.null&requested_at=lt.${before}&select=run_id,repo,workflow,sha,url`);
    for (const r of stuck) {
      report(`CI run on ${r.repo} (${r.workflow}, ${String(r.sha || '').slice(0, 7)}) was requested and never completed`, { context: r.url || '' });
      await db.patch(`ci_runs?run_id=eq.${r.run_id}`, { missing_reported_at: new Date(now()).toISOString() });
    }
    return stuck.length;
  }

  async function onWorkflowRun(payload) {
    const wr = (payload || {}).workflow_run, repoObj = (payload || {}).repository;
    if (!wr || !repoObj) return { status: 400, body: { error: 'not a workflow_run' } };
    const run = {
      run_id: wr.id, attempt: wr.run_attempt || 1, repo: repoObj.full_name, workflow: wr.name,
      sha: wr.head_sha, branch: wr.head_branch, event: wr.event, url: wr.html_url, runId: wr.id,
    };
    const row = { run_id: run.run_id, attempt: run.attempt, repo: run.repo, workflow: run.workflow, sha: run.sha,
                  branch: run.branch, event: run.event, url: run.url };
    let routed = null;
    if (payload.action === 'completed') {
      const at = new Date(now()).toISOString();
      const done = { ...row, conclusion: wr.conclusion, completed_at: at };
      if (!FAILED.has(wr.conclusion)) routed = null;
      else if (run.event !== 'push' || run.branch !== repoObj.default_branch) routed = 'skipped:not a push to the default branch';
      else routed = await routeFailure(run);
      await db.upsert('ci_runs', { ...done, routed });
    } else if (payload.action === 'requested') {
      // A re-run reuses the run id: it is requested again, and its earlier result no longer stands.
      await db.upsert('ci_runs', { ...row, conclusion: null, completed_at: null, routed: null,
                                   missing_reported_at: null, requested_at: new Date(now()).toISOString() });
    }
    await checkMissing();
    return { status: 200, body: { ok: true, routed } };
  }

  return { recordPush, onWorkflowRun, checkMissing, routeFailure };
}

module.exports = { createCi, verifySignature, prompts, MISSING_AFTER_MS };
