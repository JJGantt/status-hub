'use strict';
// The front door in the hub (data-layer README § The front door): SwitchBot's webhook, the five-minute
// backstop, and GET/POST /api/door for the watch. The Bluetooth listeners (data-layer door/) are the
// primary event source; everything here writes through the same door_report() they do.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const { stateOf } = require('../lib/door');
const { createSwitchBot } = require('../lib/switchbot');

// A backstop behind the event sources, in minutes: a change none of them recorded is written as a
// 'backstop' row and reported, because it means every event path missed it.
const BACKSTOP_MS = 5 * 60e3;

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, gated, pub, sb } = ctx;
  const HOOK = process.env.SWITCHBOT_WEBHOOK_TOKEN || '';
  const TOKEN = process.env.SWITCHBOT_TOKEN || '';
  const SECRET = process.env.SWITCHBOT_SECRET || '';
  const report = (msg) => ops.report(msg, { service: 'status-hub:switchbot' });

  // Every write goes through Supabase's door_report() (data-layer migration 00209), the one writer for
  // all sources: the Bluetooth listeners, this webhook, the hub's own lock/unlock and the backstop. Its
  // lock serialises them across machines, so one change heard twice is one row.
  async function record(next, source, raw, battery) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/door_report`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_source: source, p_lock: next.lock, p_door: next.door, p_battery: battery ?? null,
                             p_machine: 'fly', p_raw: raw ?? null }),
    });
    if (!r.ok) throw new Error(`door_report -> ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return { rows: await r.json() };
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
      const { rows } = await record(stateOf(body), 'backstop', body, battery(body));
      // A backstop row is a change no source recorded: not the Bluetooth listeners, the webhook or a
      // command. That means every event path missed it.
      if (rows.length) report(`Front door change recorded by no source: the lock reports ${rows.map((r) => r.event).join(', ')}`);
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
