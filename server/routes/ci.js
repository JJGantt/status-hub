'use strict';
// CI results back to the session that pushed — the routes. The rules are lib/ci.js; docs/CI.md is the
// whole mechanism.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const { createCi, verifySignature } = require('../lib/ci');

module.exports = function (ctx) {
  const { MACHINE_NAME, SUPABASE_KEY, SUPABASE_URL, deadLetter, followUpSession, gated, machineAwake, pub, sb, sbWrite } = ctx;
  const SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

  async function upsert(table, row) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
                 Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`supabase upsert ${table} -> ${r.status} ${await r.text()}`);
  }

  // A new session in the repo, on the Pi unless it is down, the Mac otherwise. Neither awake: the
  // command is saved like any other undeliverable one, and the caller reports it.
  async function startFix(name, prompt, label) {
    const rows = await sb(`repos?name=eq.${encodeURIComponent(name)}&select=path,name`);
    if (!rows.length) return { ok: false, error: `no machine has published a checkout of ${name}` };
    const machine = (await machineAwake('pi')) ? 'pi' : (await machineAwake('mac')) ? 'mac' : null;
    const payload = { path: rows[0].path, name: rows[0].name, target: machine || 'pi', prompt, label };
    if (!machine) {
      await deadLetter('open_session', payload, 'pi', 'neither the Pi nor the Mac is responding');
      return { ok: false, error: 'neither the Pi nor the Mac is responding; the session is saved in failures' };
    }
    const id = crypto.randomUUID();
    await sbWrite('desk_commands', 'POST', { id, kind: 'open_session', payload });
    return { ok: true, id, machine: MACHINE_NAME[machine] };
  }

  const ci = createCi({
    db: { upsert, select: sb, patch: (path, body) => sbWrite(path, 'PATCH', body) },
    followUp: (row, text) => followUpSession(row, { text }),
    startFix,
    report: (msg, extra) => ops.report(msg, { service: 'status-hub:ci', ...(extra || {}) }),
  });

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
