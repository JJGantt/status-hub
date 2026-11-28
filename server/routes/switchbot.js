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
      report(`Reading the front door for the watch failed: ${e.message || e}`);
      try {
        const row = (await sb('device_status?select=data,updated_at&device=eq.front-door'))[0];
        if (!row || !row.data) return res.status(502).json({ error: 'unreachable' });
        res.json({ lock: row.data.lock, door: row.data.door, battery: row.data.battery ?? null, at: row.updated_at, stale: true });
      } catch (e2) { console.error('[switchbot] reading device_status failed:', e2); res.status(502).json({ error: 'unreachable' }); }
    }
  });

  // `reason` names what asked for it ('elevator' from the phone's elevator watch; the watch sends none)
  // and is kept on the command's door_events row.
  gated.post('/api/door', express.json(), async (req, res) => {
    const action = req.body && req.body.action;
    if (action !== 'lock' && action !== 'unlock') return res.status(400).json({ error: 'action must be lock or unlock' });
    const reason = typeof req.body.reason === 'string' ? req.body.reason.slice(0, 40) : 'watch';
    const want = action === 'lock' ? 'locked' : 'unlocked';
    try {
      const { body } = await bot.command(want, (b) => stateOf(b).lock);
      // door_report() writes a row only if no other source has recorded the change yet.
      const { rows } = await record(stateOf(body), 'command', { ...body, reason }, battery(body));
      res.json(answer(body, { recorded: rows.length > 0 }));
    } catch (e) {
      console.error(`[switchbot] ${action} (${reason}) failed:`, e);
      report(`Front door ${action} for ${reason} failed: ${e.message || e}`);
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // The phone's elevator watch (apps/Sources/ElevatorUnlock.swift): where home is, for its geofence.
  gated.get('/api/door/home', async (req, res) => {
    try {
      const row = (await sb('app_settings?select=value&key=eq.home_location'))[0];
      const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec((row && row.value) || '');
      if (!m) { report('app_settings.home_location is missing or malformed; the elevator unlock has no home'); return res.status(404).json({ error: 'no home' }); }
      res.json({ lat: Number(m[1]), lon: Number(m[2]), radius_m: 150 });
    } catch (e) { console.error('[switchbot] reading home_location failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });

  // Each window the elevator watch ran, with its whole trace (data-layer 00212), for tuning.
  gated.post('/api/elevator/rides', express.json({ limit: '2mb' }), async (req, res) => {
    const b = req.body || {};
    const row = { device: String(b.device || 'phone').slice(0, 20), started_at: b.started_at, ended_at: b.ended_at || null,
      outcome: b.outcome, rise_m: b.rise_m ?? null, ride_s: b.ride_s ?? null, steps_in_ride: b.steps_in_ride ?? null,
      steps_after: b.steps_after ?? null, unlock_ms: b.unlock_ms ?? null, thresholds: b.thresholds ?? null,
      trace: b.trace ?? null, error: b.error ? String(b.error).slice(0, 500) : null };
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/elevator_rides`, { method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(row) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      // A hub-side failure (502) was already reported by POST /api/door.
      if (row.outcome === 'unlock_failed' && !/502/.test(row.error || '')) report(`Elevator unlock failed: ${row.error || 'no error given'}`);
      res.json({ ok: true });
    } catch (e) {
      console.error('[switchbot] storing an elevator ride failed:', e);
      report(`Storing an elevator ride failed: ${e.message || e}`);
      res.status(500).json({ error: 'failed' });
    }
  });

  if (!TOKEN || !SECRET) console.error('[switchbot] SWITCHBOT_TOKEN / SWITCHBOT_SECRET not set; the front door backstop is off');
  else { setTimeout(backstop, 30e3); setInterval(backstop, BACKSTOP_MS); }
};
