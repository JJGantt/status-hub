'use strict';
// The front door in the hub (data-layer README § The front door): SwitchBot's webhook, the five-minute
// backstop, and GET/POST /api/door for the watch. The Bluetooth listeners (data-layer door/) are the
// primary event source; everything here writes through the same door_report() they do.
const crypto = require('crypto');
const express = require('express');
const ops = require('../lib/report');
const { stateOf, leftAndCameBack } = require('../lib/door');
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
      if (want === 'unlocked' && AUTO_REASONS.test(reason)) relockAfter(reason);
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
      res.json({ lat: Number(m[1]), lon: Number(m[2]), radius_m: 500 });
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

  // ── Relock after an automatic unlock ──
  // An unlock nobody pressed for (the elevator, Wi-Fi or Bluetooth arrival) is followed by a lock: 20 s
  // after the door next closes, or 30 s after the unlock if the door never opens (a false arrival).
  // Never while the door is open, since the bolt would hit the frame. Driven by door_events as the
  // listeners write them (realtime INSERT, doorEvent); a manual lock or unlock in the meantime ends it.
  // Held in memory: a hub restart in that window drops it, which is logged at start-up as nothing.
  const AUTO_REASONS = /^(elevator|wifi|bluetooth)/;
  const RELOCK_CLOSED_MS = 20e3, RELOCK_UNOPENED_MS = 30e3;
  let relock = null;   // { reason, opened, timer }
  function relockAfter(reason) {
    if (relock) clearTimeout(relock.timer);
    relock = { reason, opened: false, timer: setTimeout(() => relockNow('the door was not opened'), RELOCK_UNOPENED_MS) };
    console.log(`[switchbot] relock armed after ${reason}`);
  }
  async function relockNow(why) {
    const r = relock;
    relock = null;
    if (!r) return;
    try {
      const s = stateOf(await bot.status());
      if (s.door === 'opened') { report(`Relock after ${r.reason} skipped: the door is open (${why})`); return; }
      if (s.lock === 'locked') return;
      const { body } = await bot.command('locked', (b) => stateOf(b).lock);
      await record(stateOf(body), 'command', { ...body, reason: `relock:${r.reason}` }, battery(body));
      console.log(`[switchbot] relocked after ${r.reason}: ${why}`);
    } catch (e) {
      console.error(`[switchbot] relock after ${r.reason} failed:`, e);
      report(`Front door relock after ${r.reason} failed: ${e.message || e}`);
    }
  }
  // A new door_events row. The relock's own lock and the auto-unlock's own row land here too.
  function doorEvent(row) {
    if (!relock || !row) return;
    if (row.event === 'opened') { relock.opened = true; clearTimeout(relock.timer); }
    else if (row.event === 'closed' && relock.opened) {
      clearTimeout(relock.timer);
      relock.timer = setTimeout(() => relockNow('the door closed'), RELOCK_CLOSED_MS);
    } else if (row.event === 'locked') { clearTimeout(relock.timer); relock = null; }
  }

  // ── Arrival approaches (docs/DOOR.md § Arrival) ──
  // Which approaches may unlock: app_settings.door_unlock_modes (data-layer 00215), so each can be tested
  // alone. Read per decision; it is one small row and the decisions are rare.
  const MODES = ['elevator', 'wifi', 'bluetooth'];
  async function modes() {
    const row = (await sb('app_settings?select=value&key=eq.door_unlock_modes'))[0];
    let m = {};
    try { m = JSON.parse((row && row.value) || '{}'); } catch (e) { report(`app_settings.door_unlock_modes is not JSON: ${e.message}`); }
    return Object.fromEntries(MODES.map((k) => [k, m[k] === true]));
  }
  // Also carries app_settings.elevator_thresholds ({"minRise": 5, ...}, ElevatorDetector.Thresholds keys),
  // which the phone applies over its defaults, so the ride rules are tuned without an app build.
  gated.get('/api/door/modes', async (req, res) => {
    try {
      const row = (await sb('app_settings?select=value&key=eq.elevator_thresholds'))[0];
      let thresholds;
      try { thresholds = row && row.value ? JSON.parse(row.value) : undefined; } catch (e) { report(`app_settings.elevator_thresholds is not JSON: ${e.message}`); }
      res.json({ ...(await modes()), ...(thresholds ? { thresholds } : {}) });
    } catch (e) { console.error('[switchbot] reading modes failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });
  gated.post('/api/door/modes', express.json(), async (req, res) => {
    try {
      const next = { ...(await modes()) };
      for (const k of MODES) if (typeof (req.body || {})[k] === 'boolean') next[k] = req.body[k];
      const r = await fetch(`${SUPABASE_URL}/rest/v1/app_settings?on_conflict=key`, { method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
                   Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: 'door_unlock_modes', value: JSON.stringify(next), updated_at: new Date().toISOString() }) });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
      res.json(next);
    } catch (e) { console.error('[switchbot] setting modes failed:', e); report(`Setting door unlock modes failed: ${e.message || e}`); res.status(502).json({ error: 'failed' }); }
  });

  // Wi-Fi joins heard by the presence listeners (data-layer presence/, table lan_joins).
  gated.get('/api/presence/joins', async (req, res) => {
    try { res.json(await sb('lan_joins?select=at,machine,mac,ip,hostname,message&order=at.desc&limit=30')); }
    catch (e) { console.error('[switchbot] reading lan_joins failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });

  // Whether an arrival at `atIso` follows him really leaving (lib/door.js leftAndCameBack), from the last
  // day of door openings, Bluetooth departures and elevator rides down. Logged either way, for tuning.
  async function cameBack(atIso, what) {
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const [opens, leaves, downs] = await Promise.all([
      sb(`door_events?select=at&event=eq.opened&at=gte.${since}`),
      sb(`presence_events?select=at&event=eq.leave&at=gte.${since}`),
      sb(`elevator_rides?select=started_at&outcome=eq.down&started_at=gte.${since}`),
    ]);
    const ms = (xs, k) => xs.map((r) => Date.parse(r[k]));
    const v = leftAndCameBack(Date.parse(atIso), { opens: ms(opens, 'at'), leaves: ms(leaves, 'at'), downs: ms(downs, 'started_at') });
    console.log(`[switchbot] ${what} at ${atIso}: ${v.ok ? 'an arrival' : 'not an arrival'} (${v.why})`);
    return v.ok;
  }

  // Phone and watch arrivals and departures heard over Bluetooth (data-layer presence/ble.py).
  gated.get('/api/presence/events', async (req, res) => {
    try { res.json(await sb('presence_events?select=at,machine,device,source,event,rssi,away_s&order=at.desc&limit=30')); }
    catch (e) { console.error('[switchbot] reading presence_events failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });

  // His phone or watch heard again over Bluetooth after being away: unlocks when the bluetooth approach is
  // on. One unlock per device a minute; an extra unlock does nothing anyway.
  const lastBleUnlock = new Map();
  async function presenceEvent(row) {
    try {
      if (!row || row.source !== 'ble' || row.event !== 'arrive') return;
      if (!(await cameBack(row.at, `${row.device} heard over Bluetooth`))) return;
      if (!(await modes()).bluetooth) { console.log(`[switchbot] ${row.device} arrived over Bluetooth; bluetooth approach is off`); return; }
      if (Date.now() - (lastBleUnlock.get(row.device) || 0) < 60e3) return;
      lastBleUnlock.set(row.device, Date.now());
      const t = Date.now();
      const { body } = await bot.command('unlocked', (b) => stateOf(b).lock);
      await record(stateOf(body), 'command', { ...body, reason: `bluetooth:${row.device}`, arrive_at: row.at }, battery(body));
      relockAfter(`bluetooth:${row.device}`);
      console.log(`[switchbot] unlocked for ${row.device} arriving over Bluetooth, ${Date.now() - t}ms`);
    } catch (e) {
      console.error('[switchbot] Bluetooth arrival unlock failed:', e);
      report(`Front door unlock for a Bluetooth arrival failed: ${e.message || e}`);
    }
  }

  // A device joining the home Wi-Fi (a DHCP Discover or Request, which a phone or watch sends only when it
  // joins or rejoins) unlocks the door when the wifi approach is on and the MAC is his: app_settings
  // presence_devices, {"<mac>": "phone" | "watch"}. Both listeners hear the same join; one unlock per
  // device a minute is plenty, and an extra unlock does nothing anyway.
  const lastWifiUnlock = new Map();
  async function lanJoined(row) {
    try { await wifiArrival(row); }
    catch (e) { console.error('[switchbot] handling a Wi-Fi join failed:', e); report(`Handling a Wi-Fi join failed: ${e.message || e}`); }
  }
  async function wifiArrival(row) {
    if (!row || !/^(Discover|Request)$/.test(String(row.message || ''))) return;
    const devRow = (await sb('app_settings?select=value&key=eq.presence_devices'))[0];
    let devices = {};
    try { devices = JSON.parse((devRow && devRow.value) || '{}'); } catch (e) { report(`app_settings.presence_devices is not JSON: ${e.message}`); return; }
    const who = devices[String(row.mac).toLowerCase()];
    if (!who) return;
    if (!(await cameBack(row.at, `${who} joined the Wi-Fi`))) return;
    if (!(await modes()).wifi) { console.log(`[switchbot] ${who} joined the Wi-Fi; wifi approach is off`); return; }
    if (Date.now() - (lastWifiUnlock.get(row.mac) || 0) < 60e3) return;
    lastWifiUnlock.set(row.mac, Date.now());
    const t = Date.now();
    try {
      const { body } = await bot.command('unlocked', (b) => stateOf(b).lock);
      await record(stateOf(body), 'command', { ...body, reason: `wifi:${who}`, join_at: row.at }, battery(body));
      relockAfter(`wifi:${who}`);
      console.log(`[switchbot] unlocked for ${who} joining the Wi-Fi, ${Date.now() - t}ms`);
    } catch (e) {
      console.error(`[switchbot] Wi-Fi unlock for ${who} failed:`, e);
      report(`Front door unlock for ${who} joining the Wi-Fi failed: ${e.message || e}`);
    }
  }

  if (!TOKEN || !SECRET) console.error('[switchbot] SWITCHBOT_TOKEN / SWITCHBOT_SECRET not set; the front door backstop is off');
  else { setTimeout(backstop, 30e3); setInterval(backstop, BACKSTOP_MS); }
  return { lanJoined, presenceEvent, doorEvent };
};
