'use strict';
// CI results back to the session that pushed — the routes. The rules are lib/ci.js; docs/CI.md is the
// whole mechanism.
const express = require('express');
const ops = require('../lib/report');
const { createCi, verifySignature } = require('../lib/ci');

module.exports = function (ctx) {
  const { MACHINE_NAME, SUPABASE_KEY, SUPABASE_URL, followUpSession, gated, openSession, pub, sb, sbWrite } = ctx;
  const SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
  // Read-only GitHub access, used only to ask about a run whose completion never arrived.
  const GH_TOKEN = process.env.GH_TOKEN || '';

  async function gh(path) {
    const r = await fetch(`https://api.github.com/${path}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'status-hub' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`GitHub ${path} -> ${r.status}`);
    return r.json();
  }

  async function lookup(repo, runId) {
    const wr = await gh(`repos/${repo}/actions/runs/${runId}`);
    const def = wr.repository && wr.repository.default_branch
      ? wr.repository.default_branch : (await gh(`repos/${repo}`)).default_branch;
    return { ...wr, default_branch: def };
  }

  async function upsert(table, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
                 Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`supabase upsert ${table} -> ${r.status} ${await r.text()}`);
  }

  // A new session in the repo, on the Pi unless it cannot take it, then the Mac, then Fly
  // (routes/sessions.js openSession). Saved like any other undeliverable command only when none did.
  async function startFix(name, prompt, label) {
    const rows = await sb(`repos?name=eq.${encodeURIComponent(name)}&select=path,name`);
    if (!rows.length) return { ok: false, error: `no machine has published a checkout of ${name}` };
    const r = await openSession({ path: rows[0].path, name: rows[0].name, prompt, label }, 'pi');
    if (!r.ok) return { ok: false, error: `${r.why}; the session is saved in failures` };
    return { ok: true, id: r.id, machine: MACHINE_NAME[r.machine] };
  }

  const ci = createCi({
    db: { upsert, select: sb, patch: (path, body) => sbWrite(path, 'PATCH', body) },
    followUp: (row, text) => followUpSession(row, { text }),
    startFix,
    report: (msg, extra) => ops.report(msg, { service: 'status-hub:ci', ...(extra || {}) }),
    lookup: GH_TOKEN ? lookup : undefined,
  });

  if (!GH_TOKEN) console.error('[ci] GH_TOKEN is not set; a CI result lost during a restart is found only after two hours');
  else ci.reconcile().catch((e) => console.error('[ci] reconciling open runs at start failed:', e));

  // GitHub's webhook, on every repo with workflows (bin/ci-webhooks installs it). Public, because
  // GitHub carries no hub credential: the HMAC over the raw body with GITHUB_WEBHOOK_SECRET is the auth,
  // checked before anything is parsed.
  pub.post('/api/ci/github', express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
    if (!SECRET) {
      console.error('[ci] GITHUB_WEBHOOK_SECRET is not set; a GitHub delivery was refused');
      return res.status(503).json({ error: 'not configured' });
    }
    if (!verifySignature(SECRET, req.body, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'bad signature' });
    const event = req.get('x-github-event');
    if (event === 'ping') return res.json({ ok: true });
    if (event !== 'workflow_run') return res.json({ ignored: event });
    try {
      const r = await ci.onWorkflowRun(JSON.parse(req.body.toString('utf8')));
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error('[ci] workflow_run failed:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // The pre-push hook's record of who pushed what (claude-config shared/git-hooks/pre-push).
  gated.post('/api/ci/pushes', express.json(), async (req, res) => {
    try {
      const r = await ci.recordPush(req.body);
      res.status(r.status).json(r.body);
    } catch (e) {
      console.error('[ci] recording a push failed:', e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });
};
