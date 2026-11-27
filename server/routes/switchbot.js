'use strict';
// The front door's SwitchBot webhook and its backstop (data-layer README § The front door). Every lock
// change and door open/close reaches SwitchBot's cloud through the Hub Mini, which POSTs it here; each
// becomes a door_events row and the device_status row 'front-door'. The data MCP's front_door tool
// reads both, and waits on door_events to confirm its own lock/unlock.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const { stateOf, eventsFor } = require('../lib/door');

// A backstop behind the webhook, in minutes: a change the webhook never delivered is written as a
// 'backstop' row and reported, because it means the webhook path is down.
const BACKSTOP_MS = 5 * 60e3;

module.exports = function (ctx) {
  const { pub, sb, sbInsert, sbUpsert } = ctx;
  const HOOK = process.env.SWITCHBOT_WEBHOOK_TOKEN || '';
  const TOKEN = process.env.SWITCHBOT_TOKEN || '';
  const SECRET = process.env.SWITCHBOT_SECRET || '';
  const report = (msg) => ops.report(msg, { service: 'status-hub:switchbot' });

  // Serialised, so two reports arriving together cannot both read the same previous row.
  let chain = Promise.resolve();
  function record(next, source, raw, battery) {
    const run = chain.then(async () => {
      const prev = (await sb('door_events?select=lock_state,door_state&order=at.desc&limit=1'))[0] || null;
      const rows = eventsFor(prev, next, source, raw);
      for (const r of rows) if (!(await sbInsert('door_events', r))) throw new Error('insert into door_events failed');
      const last = rows.length ? rows[rows.length - 1] : prev;
      const prior = (await sb("device_status?select=data&device=eq.front-door"))[0];
      await sbUpsert('device_status', 'device', {
        device: 'front-door', name: 'Front door', online: true, updated_at: new Date().toISOString(),
        status: last ? last.lock_state : null,
        data: { lock: last ? last.lock_state : null, door: last ? last.door_state : null,
                battery: battery ?? (prior && prior.data ? prior.data.battery : null) },
      });
      return { rows, first: !prev };
    });
    chain = run.catch(() => {});
    return run;
  }
  // Public, because SwitchBot carries no hub credential and signs nothing: the secret path segment
  // SWITCHBOT_WEBHOOK_TOKEN is the auth.
  pub.post('/api/switchbot/:token', express.json({ limit: '64kb' }), async (req, res) => {
    if (!HOOK) { console.error('[switchbot] SWITCHBOT_WEBHOOK_TOKEN is not set; a delivery was refused'); return res.status(503).json({ error: 'not configured' }); }
    const a = Buffer.from(String(req.params.token)), b = Buffer.from(HOOK);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'bad token' });
    const c = (req.body && req.body.context) || {};
    if (!/lock/i.test(String(c.deviceType || ''))) { console.log('[switchbot] ignored', c.deviceType); return res.json({ ignored: c.deviceType || null }); }
    const next = stateOf(c);
    if (!next.lock && !next.door) console.error('[switchbot] a lock report carried no lock or door state:', JSON.stringify(req.body).slice(0, 500));
    try {
      const { rows } = await record(next, 'webhook', req.body, typeof c.battery === 'number' ? c.battery : undefined);
      res.json({ ok: true, events: rows.map((r) => r.event) });
    } catch (e) {
      console.error('[switchbot] recording a webhook failed:', e);
      res.status(500).json({ error: 'failed' });
    }
  });

  async function api(path) {
    const t = String(Date.now()), nonce = crypto.randomUUID();
    const sign = crypto.createHmac('sha256', SECRET).update(TOKEN + t + nonce).digest('base64');
    const r = await fetch(`https://api.switch-bot.com/v1.1${path}`, { headers: { Authorization: TOKEN, sign, t, nonce }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (!r.ok || j.statusCode !== 100) throw new Error(`SwitchBot ${path} -> HTTP ${r.status}, statusCode ${j.statusCode} ${j.message || ''}`);
    return j.body;
  }
  let lockId = process.env.SWITCHBOT_LOCK_ID || '';
  async function backstop() {
    try {
      if (!lockId) {
        const locks = ((await api('/devices')).deviceList || []).filter((d) => /lock/i.test(String(d.deviceType)));
        if (locks.length !== 1) throw new Error(`expected one lock on the SwitchBot account, found ${locks.length}`);
        lockId = locks[0].deviceId;
      }
      const body = await api(`/devices/${lockId}/status`);
      const { rows, first } = await record(stateOf(body), 'backstop', body, typeof body.battery === 'number' ? body.battery : undefined);
      // The first row ever has nothing to have missed; after that a backstop row is a missed webhook.
      if (rows.length && !first) report(`Front door webhook missed: the lock reports ${rows.map((r) => r.event).join(', ')} with no event delivered`);
    } catch (e) { console.error('[switchbot] backstop failed:', e); }
  }
  if (!TOKEN || !SECRET) console.error('[switchbot] SWITCHBOT_TOKEN / SWITCHBOT_SECRET not set; the front door backstop is off');
  else { setTimeout(backstop, 30e3); setInterval(backstop, BACKSTOP_MS); }
};
