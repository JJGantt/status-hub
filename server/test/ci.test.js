'use strict';
// lib/ci.js: a failed CI run goes back to the session that pushed it. A wrong answer here either
// interrupts a session about nothing, or lets a red test sit unseen for a day — which is what this
// exists to stop.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createCi, verifySignature, MISSING_AFTER_MS } = require('../lib/ci');

const SHA = 'a'.repeat(40);
const T0 = Date.parse('2026-11-03T20:00:00Z');

// An in-memory stand-in for the three tables the module touches, read through the same PostgREST
// paths it builds.
function fixture({ pushes = [], sessions = [], followUp = { status: 200, body: { id: 'cmd' } }, fix = { ok: true, id: 'new-1' } } = {}) {
  const runs = new Map();
  const calls = { followUps: [], fixes: [], reports: [] };
  let clock = T0;
  const db = {
    async upsert(table, row) {
      if (table === 'ci_runs') runs.set(row.run_id, { ...(runs.get(row.run_id) || {}), ...row });
      if (table === 'ci_pushes') pushes.push(row);
    },
    async select(path) {
      const q = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const eq = (k) => (q.get(k) || '').replace(/^eq\./, '');
      if (path.startsWith('ci_pushes')) return pushes.filter((p) => p.repo === decodeURIComponent(eq('repo')) && p.sha === eq('sha'));
      if (path.startsWith('desk_sessions')) {
        return sessions.filter((s) => s.claude_session_id === eq('claude_session_id') && ['resident', 'evicted'].includes(s.status));
      }
      if (path.startsWith('ci_runs?run_id=')) {
        const r = runs.get(Number(eq('run_id')));
        return r ? [r] : [];
      }
      if (path.startsWith('ci_runs')) {
        const before = Date.parse(q.get('requested_at').replace(/^lt\./, ''));
        return [...runs.values()].filter((r) => !r.completed_at && !r.missing_reported_at && Date.parse(r.requested_at) < before);
      }
      throw new Error(`unexpected select ${path}`);
    },
    async patch(path, body) {
      const id = Number(path.match(/run_id=eq\.(\d+)/)[1]);
      runs.set(id, { ...runs.get(id), ...body });
    },
  };
  const ci = createCi({
    db,
    followUp: async (row, text) => { calls.followUps.push({ row, text }); return followUp; },
    startFix: async (name, prompt, label) => { calls.fixes.push({ name, prompt, label }); return fix; },
    report: (msg) => calls.reports.push(msg),
    now: () => clock,
  });
  return { ci, runs, calls, pushes, advance: (ms) => { clock += ms; } };
}

const run = (action, over = {}) => ({
  action,
  repository: { full_name: 'JJGantt/data-layer', default_branch: 'main' },
  workflow_run: { id: 41740664091, run_attempt: 1, name: 'test', head_sha: SHA, head_branch: 'main', event: 'push',
                  html_url: 'https://github.com/JJGantt/data-layer/actions/runs/41740664091', conclusion: null, ...over },
});
const completed = (conclusion, over) => run('completed', { conclusion, ...over });

describe('a failed run on a push to the default branch', () => {
  test('goes to the session that pushed it, as a follow-up naming the run', async () => {
    const f = fixture({ pushes: [{ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: 'conv-1' }],
                        sessions: [{ id: 'mac-1', claude_session_id: 'conv-1', status: 'resident' }] });
    const r = await f.ci.onWorkflowRun(completed('failure'));
    assert.equal(r.body.routed, 'session:conv-1');
    assert.equal(f.calls.followUps.length, 1);
    assert.equal(f.calls.followUps[0].row.id, 'mac-1');
    assert.match(f.calls.followUps[0].text, /gh run view 41740664091 -R JJGantt\/data-layer --log-failed/);
    assert.match(f.calls.followUps[0].text, /aaaaaaa/);
    assert.equal(f.calls.fixes.length, 0);
    assert.equal(f.runs.get(41740664091).routed, 'session:conv-1');
  });

  test('reaches a parked session too, since a follow-up resumes it', async () => {
    const f = fixture({ pushes: [{ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: 'conv-1' }],
                        sessions: [{ id: 'pi-1', claude_session_id: 'conv-1', status: 'evicted' }] });
    assert.equal((await f.ci.onWorkflowRun(completed('failure'))).body.routed, 'session:conv-1');
  });

  test('timed_out and startup_failure count as failures', async () => {
    for (const c of ['timed_out', 'startup_failure']) {
      const f = fixture();
      assert.equal((await f.ci.onWorkflowRun(completed(c))).body.routed, 'new:new-1');
    }
  });

  test('with no session recorded, a new session is started in the repo', async () => {
    const f = fixture();
    const r = await f.ci.onWorkflowRun(completed('failure'));
    assert.equal(r.body.routed, 'new:new-1');
    assert.equal(f.calls.fixes[0].name, 'data-layer');
    assert.match(f.calls.fixes[0].prompt, /not running/);
    assert.match(f.calls.fixes[0].prompt, /git show aaaaaaa/);
  });

  test('a session that has ended gets a new session instead', async () => {
    const f = fixture({ pushes: [{ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: 'conv-1' }],
                        sessions: [{ id: 'mac-1', claude_session_id: 'conv-1', status: 'ended' }] });
    assert.equal((await f.ci.onWorkflowRun(completed('failure'))).body.routed, 'new:new-1');
    assert.equal(f.calls.followUps.length, 0);
  });

  test('a follow-up that could not be delivered and was not saved falls back to a new session', async () => {
    const f = fixture({ pushes: [{ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: 'conv-1' }],
                        sessions: [{ id: 'mac-1', claude_session_id: 'conv-1', status: 'resident' }],
                        followUp: { status: 409, body: { error: 'that session is still opening' } } });
    assert.equal((await f.ci.onWorkflowRun(completed('failure'))).body.routed, 'new:new-1');
  });

  test('a follow-up saved for an asleep machine is left to arrive, not duplicated', async () => {
    const f = fixture({ pushes: [{ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: 'conv-1' }],
                        sessions: [{ id: 'mac-1', claude_session_id: 'conv-1', status: 'resident' }],
                        followUp: { status: 409, body: { error: 'the Mac is not responding', saved: 'dl-1' } } });
    assert.equal((await f.ci.onWorkflowRun(completed('failure'))).body.routed, 'saved:conv-1');
    assert.equal(f.calls.fixes.length, 0);
  });

  test('when no session can be started at all, it is reported to the responder', async () => {
    const f = fixture({ fix: { ok: false, error: 'neither the Pi nor the Mac is responding' } });
    const r = await f.ci.onWorkflowRun(completed('failure'));
    assert.match(r.body.routed, /^unrouted:/);
    assert.equal(f.calls.reports.length, 1);
    assert.match(f.calls.reports[0], /could not be sent to any session/);
  });
});

describe('runs that need nobody', () => {
  test('a success, a cancel, a skip or a neutral run sends nothing', async () => {
    for (const c of ['success', 'cancelled', 'skipped', 'neutral']) {
      const f = fixture();
      const r = await f.ci.onWorkflowRun(completed(c));
      assert.equal(r.body.routed, null);
      assert.equal(f.calls.followUps.length + f.calls.fixes.length + f.calls.reports.length, 0);
      assert.equal(f.runs.get(41740664091).conclusion, c);
    }
  });

  test('a failure on a pull request or another branch is recorded and not routed', async () => {
    for (const over of [{ event: 'pull_request' }, { head_branch: 'experiment' }]) {
      const f = fixture();
      const r = await f.ci.onWorkflowRun(completed('failure', over));
      assert.match(r.body.routed, /^skipped:/);
      assert.equal(f.calls.fixes.length, 0);
    }
  });
});

describe('a run that never completes', () => {
  test('is reported once, at the first webhook after two hours', async () => {
    const f = fixture();
    await f.ci.onWorkflowRun(run('requested'));
    f.advance(MISSING_AFTER_MS - 60e3);
    await f.ci.onWorkflowRun(run('requested', { id: 2 }));
    assert.equal(f.calls.reports.length, 0);
    f.advance(120e3);
    await f.ci.onWorkflowRun(run('requested', { id: 3 }));
    assert.equal(f.calls.reports.length, 1);
    assert.match(f.calls.reports[0], /requested and never completed/);
    await f.ci.onWorkflowRun(run('requested', { id: 4 }));
    assert.equal(f.calls.reports.length, 1);
  });

  test('a completed run is never reported missing, and a re-run starts its clock again', async () => {
    const f = fixture();
    await f.ci.onWorkflowRun(run('requested'));
    await f.ci.onWorkflowRun(completed('success'));
    f.advance(MISSING_AFTER_MS * 2);
    await f.ci.onWorkflowRun(run('requested', { id: 9 }));
    assert.equal(f.calls.reports.length, 0);
    await f.ci.onWorkflowRun(run('in_progress', { run_attempt: 2 }));
    assert.equal(f.runs.get(41740664091).completed_at, null);
    assert.equal(f.runs.get(41740664091).attempt, 2);
  });

  test('a start delivered after its own completion does not erase the result', async () => {
    const f = fixture();
    await f.ci.onWorkflowRun(completed('success'));
    await f.ci.onWorkflowRun(run('requested'));
    await f.ci.onWorkflowRun(run('in_progress'));
    assert.equal(f.runs.get(41740664091).conclusion, 'success');
    f.advance(MISSING_AFTER_MS * 2);
    await f.ci.onWorkflowRun(run('requested', { id: 9 }));
    assert.equal(f.calls.reports.length, 0);
  });

  test('in_progress after requested keeps the original start time', async () => {
    const f = fixture();
    await f.ci.onWorkflowRun(run('requested'));
    const t = f.runs.get(41740664091).requested_at;
    f.advance(60e3);
    await f.ci.onWorkflowRun(run('in_progress'));
    assert.equal(f.runs.get(41740664091).requested_at, t);
  });
});

describe('recording a push', () => {
  test('stores the conversation against the repo and commit', async () => {
    const f = fixture();
    const r = await f.ci.recordPush({ repo: 'JJGantt/data-layer', sha: SHA.toUpperCase(), branch: 'main',
                                      claude_session_id: 'conv-1', hub_session_id: 'mac-1', machine: 'mac' });
    assert.equal(r.status, 200);
    assert.equal(f.pushes[0].sha, SHA);
    assert.equal(f.pushes[0].claude_session_id, 'conv-1');
  });

  test('a push by hand records no session', async () => {
    const f = fixture();
    await f.ci.recordPush({ repo: 'JJGantt/data-layer', sha: SHA, claude_session_id: '' });
    assert.equal(f.pushes[0].claude_session_id, null);
  });

  test('refuses a repo that is not owner/name or a sha that is not a full commit id', async () => {
    const f = fixture();
    for (const b of [{ repo: 'data-layer', sha: SHA }, { repo: 'JJGantt/data-layer', sha: 'abc123' },
                     { repo: 'JJGantt/data-layer&x=1', sha: SHA }, {}]) {
      assert.equal((await f.ci.recordPush(b)).status, 400);
    }
    assert.equal(f.pushes.length, 0);
  });
});

describe('the webhook signature', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"action":"completed"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  test('the HMAC of the raw body is accepted', () => assert.equal(verifySignature(secret, body, sig), true));
  test('a wrong secret, an altered body, a missing header or no secret configured is refused', () => {
    assert.equal(verifySignature('other', body, sig), false);
    assert.equal(verifySignature(secret, Buffer.from('{"action":"requested"}'), sig), false);
    assert.equal(verifySignature(secret, body, undefined), false);
    assert.equal(verifySignature('', body, sig), false);
    assert.equal(verifySignature(secret, body, sig.slice(0, -1)), false);
  });
});
