'use strict';
// The front door's SwitchBot webhook and its backstop (data-layer README § The front door). Every lock
// change and door open/close reaches SwitchBot's cloud through the Hub Mini, which POSTs it here; each
// becomes a door_events row and the device_status row 'front-door'. The data MCP's front_door tool
// reads both, and waits on door_events to confirm its own lock/unlock.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const { stateOf, eventsFor } = require('../lib/door');
const { createSwitchBot } = require('../lib/switchbot');

// A backstop behind the webhook, in minutes: a change the webhook never delivered is written as a
// 'backstop' row and reported, because it means the webhook path is down.
const BACKSTOP_MS = 5 * 60e3;

module.exports = function (ctx) {
  const { gated, pub, sb, sbInsert, sbUpsert } = ctx;
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

  const bot = createSwitchBot({ token: TOKEN, secret: SECRET, lockId: process.env.SWITCHBOT_LOCK_ID || '' });
  const battery = (b) => (typeof b.battery === 'number' ? b.battery : undefined);

  async function backstop() {
    try {
      const body = await bot.status();
      const { rows, first } = await record(stateOf(body), 'backstop', body, battery(body));
      // The first row ever has nothing to have missed; after that a backstop row is a missed webhook.
      if (rows.length && !first) report(`Front door webhook missed: the lock reports ${rows.map((r) => r.event).join(', ')} with no event delivered`);
    } catch (e) { console.error('[switchbot] backstop failed:', e); }
  }

  const answer = (body, extra = {}) => {
    const s = stateOf(body);
    return { lock: s.lock, door: s.door, battery: battery(body) ?? null, at: new Date().toISOString(), ...extra };
  };

  // The watch's front-door complication and Control Center toggle (apps/WatchWidgets/Door.swift).
  // Live from SwitchBot; when SwitchBot cannot be reached, the last recorded state, marked stale.
  gated.get('/api/door', async (req, res) => {
    try {
      res.json(answer(await bot.status()));
    } catch (e) {
      console.error('[switchbot] reading the door failed:', e);
      try {
        const row = (await sb('device_status?select=data,updated_at&device=eq.front-door'))[0];
        if (!row || !row.data) return res.status(502).json({ error: 'unreachable' });
        res.json({ lock: row.data.lock, door: row.data.door, battery: row.data.battery ?? null, at: row.updated_at, stale: true });
      } catch (e2) { console.error('[switchbot] reading device_status failed:', e2); res.status(502).json({ error: 'unreachable' }); }
    }
  });

  gated.post('/api/door', express.json(), async (req, res) => {
    const action = req.body && req.body.action;
    if (action !== 'lock' && action !== 'unlock') return res.status(400).json({ error: 'action must be lock or unlock' });
    const want = action === 'lock' ? 'locked' : 'unlocked';
    try {
      const { body, changed } = await bot.command(want, (b) => stateOf(b).lock);
      if (changed) await record(stateOf(body), 'command', body, battery(body));
      res.json(answer(body, { changed }));
    } catch (e) {
      console.error(`[switchbot] ${action} from the hub failed:`, e);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  if (!TOKEN || !SECRET) console.error('[switchbot] SWITCHBOT_TOKEN / SWITCHBOT_SECRET not set; the front door backstop is off');
  else { setTimeout(backstop, 30e3); setInterval(backstop, BACKSTOP_MS); }
};
