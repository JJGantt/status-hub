'use strict';
// The building's downstairs door (ButterflyMX), opened by racing every path to his phone
// (docs/DOOR.md § Lobby door). A race is a lobby_races row (data-layer 00219), started by
// POST /api/lobby/open or the data MCP's front_door `lobby` op. The hub sends the SMS (Twilio) and the
// email (Gmail API, to his iCloud address); the Mac sends the iMessage (data-layer lobby.ts). His phone's
// Shortcuts automation opens the door on whichever lands first, then reports it here, publicly: the
// one-time code in the message is the authorization. Every report, losers included, is kept, so each
// race shows which path won and how long each took.
const express = require('express');
const ops = require('../lib/report');
const { DOORS, message, judgeArrival, summarize } = require('../lib/lobby');
const gmail = require('../lib/gmail');

// A race nobody's phone reported within this long, with at least one path sent, is a failure: the
// messages went out and the door did not open (or the shortcut never reported).
const NO_ARRIVAL_MS = 90e3;

module.exports = function (ctx) {
  const { SUPABASE_KEY, SUPABASE_URL, gated, pub, sb } = ctx;
  const report = (msg) => ops.report(msg, { service: 'status-hub:lobby' });
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  async function insert(table, row, returning = false) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method: 'POST',
      headers: { ...headers, Prefer: returning ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`insert into ${table}: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return returning ? (await r.json())[0] : null;
  }
  async function setting(key) {
    const row = (await sb(`app_settings?select=value&key=eq.${key}`))[0];
    return row && row.value ? String(row.value).trim() : '';
  }

  // ── The paths the hub sends ──
  // Each answers { skipped: why } when the path is not set up, and throws on a failed send.
  async function sendSms(text) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from } = process.env;
    const to = await setting('lobby_phone');
    if (!sid || !tok || !from) return { skipped: 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM not set' };
    if (!to) return { skipped: 'app_settings.lobby_phone not set' };
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', signal: AbortSignal.timeout(15e3),
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${tok}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
    if (!r.ok) throw new Error(`Twilio ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return {};
  }
  async function sendEmail(text) {
    const to = await setting('lobby_icloud_email');
    if (!gmail.configured()) return { skipped: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN not set' };
    if (!to) return { skipped: 'app_settings.lobby_icloud_email not set' };
    const raw = Buffer.from(`To: ${to}\r\nSubject: ${text}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`).toString('base64url');
    await gmail.api('messages/send', { method: 'POST', body: { raw } });
    return {};
  }

  async function send(race, path, fn) {
    try {
      const r = await fn(message(race.door, race.nonce, path));
      if (r.skipped) console.log(`[lobby] ${race.id} ${path} skipped: ${r.skipped}`);
      await insert('lobby_events', { race_id: race.id, kind: 'send', path, ok: !r.skipped, skipped: !!r.skipped, error: r.skipped || null });
      return !r.skipped;
    } catch (e) {
      console.error(`[lobby] ${race.id} ${path} send failed:`, e);
      report(`Lobby door ${path} send failed: ${e.message || e}`);
      await insert('lobby_events', { race_id: race.id, kind: 'send', path, ok: false, error: String(e.message || e).slice(0, 300) })
        .catch((e2) => console.error('[lobby] recording a failed send failed:', e2));
      return false;
    }
  }

  // A race started (realtime INSERT on lobby_races, or the POST below): send the hub's paths, then check
  // that the phone reported one. Started is remembered so the POST and its own realtime echo send once.
  const started = new Set();
  async function raceStarted(race) {
    if (!race || started.has(race.id)) return;
    started.add(race.id);
    setTimeout(() => started.delete(race.id), 10 * 60e3);
    const sent = await Promise.all([send(race, 'sms', sendSms), send(race, 'email', sendEmail)]);
    setTimeout(async () => {
      try {
        const events = await sb(`lobby_events?select=kind,path,ok,skipped&race_id=eq.${race.id}`);
        const anySent = sent.some(Boolean) || events.some((e) => e.kind === 'send' && e.path === 'imessage' && e.ok);
        if (anySent && !events.some((e) => e.kind === 'arrive')) {
          report(`Lobby door race ${race.id} (${race.reason || 'no reason'}): messages went out and no phone report came back in ${NO_ARRIVAL_MS / 1000}s`);
        }
      } catch (e) { console.error('[lobby] checking a race for an arrival failed:', e); report(`Checking lobby race ${race.id} failed: ${e.message || e}`); }
    }, NO_ARRIVAL_MS);
  }

  gated.post('/api/lobby/open', express.json(), async (req, res) => {
    try {
      const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.slice(0, 60) : 'hub';
      const door = (req.body || {}).door || 'main';
      if (!DOORS.includes(door)) return res.status(400).json({ error: `door must be one of ${DOORS.join(', ')}` });
      const race = await insert('lobby_races', { reason, door }, true);
      raceStarted(race);
      res.json({ id: race.id, started: race.created_at });
    } catch (e) {
      console.error('[lobby] starting a race failed:', e);
      report(`Starting a lobby door race failed: ${e.message || e}`);
      res.status(502).json({ error: 'failed' });
    }
  });

  // The phone's report, sent by the Shortcuts automation right after it opens the door. Public: the
  // code is one-time per path and expires (lib/lobby.js), and nothing here opens anything.
  // `opened` is reported after the door's unlock shortcut; `started` (measurement) at the automation's
  // first step, before it. Each at most once per path per race.
  const stageReport = (stage, kind) => async (req, res) => {
      const { nonce, path } = req.params;
      try {
        if (!/^[A-Za-z0-9_-]{8,32}$/.test(nonce)) return res.status(404).type('text').send('unknown code');
        const race = (await sb(`lobby_races?select=id,created_at,reason,door&nonce=eq.${encodeURIComponent(nonce)}`))[0] || null;
        const seen = race ? (await sb(`lobby_events?select=path&kind=eq.${kind}&race_id=eq.${race.id}`)).map((e) => e.path) : [];
        const v = judgeArrival(race, path, seen, Date.now());
        if (!v.ok) return res.status(v.status).type('text').send(v.why);
        await insert('lobby_events', { race_id: race.id, kind, path });
        console.log(`[lobby] ${race.id} ${path} ${stage}${seen.length ? '' : ' first'}`);
        res.type('text').send('ok');
      } catch (e) {
        console.error(`[lobby] recording a ${stage} report failed:`, e);
        report(`Recording a lobby door ${stage} report failed: ${e.message || e}`);
        res.status(500).type('text').send('failed');
      }
    };
  pub.get('/api/lobby/opened/:nonce/:path', stageReport('opened', 'arrive'));
  pub.get('/api/lobby/started/:nonce/:path', stageReport('started', 'start'));

  gated.get('/api/lobby/races', async (req, res) => {
    try {
      const races = await sb('lobby_races?select=id,created_at,reason,door&order=created_at.desc&limit=10');
      const ids = races.map((r) => r.id);
      const events = ids.length ? await sb(`lobby_events?select=race_id,kind,path,ok,skipped,error,at&race_id=in.(${ids.join(',')})`) : [];
      res.json(races.map((r) => summarize(r, events.filter((e) => e.race_id === r.id))));
    } catch (e) { console.error('[lobby] reading races failed:', e); res.status(502).json({ error: 'unreachable' }); }
  });

  // Start a race from inside the hub (the PIN by text or email): the row, its paths sent.
  async function startRace(reason, door = 'main') {
    const race = await insert('lobby_races', { reason, door }, true);
    raceStarted(race);
    return race;
  }

  return { startRace, lobbyRace: (row) => raceStarted(row).catch((e) => { console.error('[lobby] race failed:', e); report(`Lobby door race failed: ${e.message || e}`); }) };
};

